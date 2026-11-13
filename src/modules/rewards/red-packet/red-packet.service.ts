import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { USER_STATUS_ACTIVE } from '../../../common/auth/user-status';
import { ClockService } from '../../../common/clock/clock.service';
import {
  nextShanghaiDate,
  previousShanghaiDate,
  shanghaiAt,
  shanghaiBizDate,
} from '../../../common/clock/shanghai-calendar';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../../config/tokens';
import { PRODUCT_ZONE_STARTUP } from '../../catalog/catalog.constants';
import { ORDER_PAID, ORDER_SHIPPED } from '../../orders/order.constants';
import { WALLET_WITHDRAWABLE } from '../../wallet/wallet.constants';
import { AwardCreditService } from '../award-credit.service';
import { RED_PACKET_BIZ } from './red-packet.constants';
import { describeWelfareQuota, splitPool, type WelfareQuota } from './red-packet.policy';

type Db = Prisma.TransactionClient | PrismaService;

const PAID_STATUSES = [ORDER_PAID, ORDER_SHIPPED];

export interface WelfareStatus {
  eligible: boolean;
  signedUpToday: boolean;
}

export interface WelfareQuote extends WelfareQuota {
  actualPayFen: bigint;
  cumulativeClaimedFen: bigint;
}

/**
 * 福利专场。会员看到的只有能不能报名、今天有没有报过名。
 * 轮次、上限和已领金额只给管理端。
 * 报名立即生效。前一个上海自然日在每日报单检查的同一个钟点结算，默认 00:01。
 */
@Injectable()
export class RedPacketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly credits: AwardCreditService,
  ) {}

  async statusFor(userId: bigint): Promise<WelfareStatus> {
    const now = await this.clock.now();
    const user = await this.requireActive(this.prisma, userId);
    return this.statusIn(this.prisma, user, shanghaiBizDate(now));
  }

  async signup(userId: bigint): Promise<WelfareStatus> {
    const now = await this.clock.now();
    const bizDate = shanghaiBizDate(now);
    return this.prisma.$transaction(async (tx) => {
      const user = await this.requireActive(tx, userId);
      const existing = await tx.redPacketSignup.findFirst({ where: { userId, bizDate } });
      if (!existing) {
        const quote = await this.quoteIn(tx, userId);
        if (!user.member || !quote.moneyEligible) {
          throw new ForbiddenException('不具备资格');
        }
        try {
          await tx.redPacketSignup.create({
            data: { userId, bizDate, signedAt: now, createdAt: now },
          });
        } catch (error) {
          if (!isUniqueConflict(error)) {
            throw error;
          }
        }
      }
      return this.statusIn(tx, user, bizDate);
    });
  }

  async quoteFor(userId: bigint): Promise<WelfareQuote> {
    return this.quoteIn(this.prisma, userId);
  }

  async quotesFor(userIds: bigint[]): Promise<Map<string, WelfareQuote>> {
    const quotes = new Map<string, WelfareQuote>();
    if (userIds.length === 0) {
      return quotes;
    }
    const [payByUser, claimedByUser] = await Promise.all([
      this.actualPayByUser(this.prisma, userIds),
      this.claimedByUser(this.prisma, userIds),
    ]);
    for (const userId of userIds) {
      const key = userId.toString();
      quotes.set(key, this.toQuote(payByUser.get(key) ?? 0n, claimedByUser.get(key) ?? 0n));
    }
    return quotes;
  }

  /**
   * 结算已经结束、并且当日检查钟点已到的上海自然日。
   * 今天 00:01 结算昨天。00:01 之前不结算昨天。
   * 重跑同一天不会再次入账。
   */
  async runDue(): Promise<void> {
    const now = await this.clock.now();
    const latest = this.latestSettleableBizDate(now);
    const anchor = await this.prisma.redPacketDailyAccrual.findFirst({
      orderBy: { bizDate: 'desc' },
    });
    let cursor: string;
    if (!anchor) {
      const earliest = await this.prisma.redPacketSignup.findFirst({
        orderBy: { bizDate: 'asc' },
      });
      cursor = earliest && earliest.bizDate <= latest ? earliest.bizDate : latest;
    } else if (anchor.settledAt) {
      cursor = nextShanghaiDate(anchor.bizDate);
    } else {
      cursor = anchor.bizDate;
    }
    while (cursor <= latest) {
      await this.settleDay(cursor, now);
      cursor = nextShanghaiDate(cursor);
    }
  }

  private async settleDay(bizDate: string, now: Date): Promise<void> {
    const existing = await this.prisma.redPacketDailyAccrual.findUnique({ where: { bizDate } });
    if (existing?.settledAt) {
      return;
    }
    if (!existing) {
      try {
        await this.prisma.redPacketDailyAccrual.create({
          data: {
            bizDate,
            startupSalesFen: 0n,
            accrualFen: 0n,
            signupCount: 0,
            shareFen: 0n,
            distributedFen: 0n,
            remainderFen: 0n,
            accruedAt: now,
            settledAt: null,
            createdAt: now,
          },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    }
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
        SELECT id FROM red_packet_daily_accruals WHERE biz_date = ${bizDate} FOR UPDATE
      `;
        const row = await tx.redPacketDailyAccrual.findUnique({ where: { bizDate } });
        if (!row || row.settledAt) {
          return;
        }
        const from = shanghaiAt(bizDate, 0, 0);
        const until = shanghaiAt(nextShanghaiDate(bizDate), 0, 0);
        const salesFen = await this.startupSalesFen(tx, from, until);
        const signups = await tx.redPacketSignup.findMany({
          where: { bizDate },
          orderBy: [{ userId: 'asc' }, { id: 'asc' }],
        });
        const split = splitPool(salesFen, this.locked.redPacketDailyAccrualBps, signups.length);
        if (split.shareFen > 0n) {
          for (const signup of signups) {
            await this.payShare(tx, signup.userId, bizDate, split.shareFen, now);
          }
        }
        await tx.redPacketDailyAccrual.update({
          where: { bizDate },
          data: {
            startupSalesFen: salesFen,
            accrualFen: split.poolFen,
            signupCount: signups.length,
            shareFen: split.shareFen,
            distributedFen: split.distributedFen,
            remainderFen: split.remainderFen,
            accruedAt: now,
            settledAt: now,
          },
        });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private async payShare(
    tx: Prisma.TransactionClient,
    userId: bigint,
    bizDate: string,
    shareFen: bigint,
    now: Date,
  ): Promise<void> {
    const existing = await tx.redPacketPayout.findFirst({ where: { userId, bizDate } });
    if (existing) {
      return;
    }
    await this.credits.creditParts(tx, {
      userId,
      bizType: RED_PACKET_BIZ,
      bizId: bizDate,
      rewardType: RED_PACKET_BIZ,
      rewardFen: shareFen,
      now,
      parts: [
        {
          walletType: WALLET_WITHDRAWABLE,
          amountFen: shareFen,
          sourceCode: RED_PACKET_BIZ,
        },
      ],
    });
    try {
      await tx.redPacketPayout.create({
        data: {
          userId,
          bizDate,
          amountFen: shareFen,
          creditedAt: now,
          createdAt: now,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
    }
  }

  private latestSettleableBizDate(now: Date): string {
    const today = shanghaiBizDate(now);
    const due = checkInstant(today, this.locked.filingDailyCheckTime);
    const yesterday = previousShanghaiDate(today);
    if (now.getTime() >= due.getTime()) {
      return yesterday;
    }
    return previousShanghaiDate(yesterday);
  }

  private async statusIn(db: Db, user: User, bizDate: string): Promise<WelfareStatus> {
    const quote = await this.quoteIn(db, user.id);
    const signup = await db.redPacketSignup.findFirst({
      where: { userId: user.id, bizDate },
    });
    return {
      eligible: user.member && quote.moneyEligible,
      signedUpToday: signup !== null,
    };
  }

  private async quoteIn(db: Db, userId: bigint): Promise<WelfareQuote> {
    const [pay, claimed] = await Promise.all([
      this.actualPayByUser(db, [userId]),
      this.claimedByUser(db, [userId]),
    ]);
    const key = userId.toString();
    return this.toQuote(pay.get(key) ?? 0n, claimed.get(key) ?? 0n);
  }

  private toQuote(actualPayFen: bigint, cumulativeClaimedFen: bigint): WelfareQuote {
    return {
      actualPayFen,
      cumulativeClaimedFen,
      ...describeWelfareQuota(
        actualPayFen,
        cumulativeClaimedFen,
        this.locked.redPacketRoundPayThresholdFen,
        this.locked.redPacketRoundClaimCapFen,
      ),
    };
  }

  private async actualPayByUser(db: Db, userIds: bigint[]): Promise<Map<string, bigint>> {
    const totals = new Map<string, bigint>();
    if (userIds.length === 0) {
      return totals;
    }
    const orders = await db.order.findMany({
      where: {
        userId: { in: userIds },
        zone: PRODUCT_ZONE_STARTUP,
        status: { in: PAID_STATUSES },
      },
    });
    for (const order of orders) {
      const key = order.userId.toString();
      totals.set(key, (totals.get(key) ?? 0n) + BigInt(order.wechatFen));
    }
    return totals;
  }

  private async claimedByUser(db: Db, userIds: bigint[]): Promise<Map<string, bigint>> {
    const totals = new Map<string, bigint>();
    if (userIds.length === 0) {
      return totals;
    }
    const payouts = await db.redPacketPayout.findMany({
      where: { userId: { in: userIds } },
    });
    for (const payout of payouts) {
      const key = payout.userId.toString();
      totals.set(key, (totals.get(key) ?? 0n) + payout.amountFen);
    }
    return totals;
  }

  /** 当日创业专区销售总额：已支付订单的商品金额，不含运费，不含商城。 */
  private async startupSalesFen(db: Db, from: Date, until: Date): Promise<bigint> {
    const orders = await db.order.findMany({
      where: {
        zone: PRODUCT_ZONE_STARTUP,
        status: { in: PAID_STATUSES },
        paidAt: { gte: from, lt: until },
      },
    });
    let total = 0n;
    for (const order of orders) {
      total += BigInt(order.goodsTotalFen);
    }
    return total;
  }

  private async requireActive(db: Db, userId: bigint): Promise<User> {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== USER_STATUS_ACTIVE) {
      throw new UnauthorizedException('登录已失效');
    }
    return user;
  }
}

function checkInstant(bizDate: string, clockTime: string): Date {
  const [hourRaw, minuteRaw] = clockTime.split(':');
  if (hourRaw === undefined || minuteRaw === undefined) {
    throw new InternalServerErrorException('红包结算时间不正确');
  }
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new InternalServerErrorException('红包结算时间不正确');
  }
  return shanghaiAt(bizDate, hour, minute);
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
