import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Prisma, StartupSubOrder } from '@prisma/client';
import { ClockService } from '../../../common/clock/clock.service';
import { enqueueNotify } from '../../../common/notify/notify-buffer';
import {
  nextShanghaiDate,
  shanghaiAt,
  shanghaiBizDate,
} from '../../../common/clock/shanghai-calendar';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../../config/tokens';
import { MESSAGE_CATEGORY_WALLET } from '../../messages/message.constants';
import { MessagesService, yuanText } from '../../messages/messages.service';
import { WALLET_POINTS, WALLET_WITHDRAWABLE } from '../../wallet/wallet.constants';
import { AwardCreditService } from '../award-credit.service';
import { applyBps } from '../award-split';

type Tx = Prisma.TransactionClient;

const FILING_FILED = 'filed';
const FILING_SETTLED = 'settled';
const SOURCE_FILING = 'filing_settlement';
const COUNTER_SLOT = 1;

interface SubOrderPick {
  id: bigint;
  userId: bigint;
  orderAt: Date;
}

/**
 * 报单由系统完成，会员没有报单操作。
 * 支付当天若此人还没报过，立刻报本次新子单里 id 最小的一笔。
 * 每日检查在启动时读入的钟点跑一次，按订单时间、再按子单 id，每人只报一笔积压。
 * 全局序号每满 5 的倍数，立刻给序号 k 的那一笔入账，然后继续。
 */
@Injectable()
export class FilingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly credits: AwardCreditService,
    private readonly messages: MessagesService,
  ) {}

  async onStartupPaid(
    tx: Tx,
    order: { id: bigint; userId: bigint; placedAt: Date },
    paidAt: Date,
  ): Promise<void> {
    await this.ensureSubOrders(tx, order, paidAt);
    const bizDate = shanghaiBizDate(paidAt);
    const already = await tx.filing.findFirst({
      where: { userId: order.userId, bizDate },
    });
    if (already) {
      return;
    }
    const pending = await tx.startupSubOrder.findMany({
      where: { orderId: order.id, filedAt: null },
    });
    const chosen = smallestId(pending);
    if (!chosen) {
      return;
    }
    await this.fileSubOrder(tx, chosen.id, bizDate, paidAt);
  }

  async runDue(): Promise<void> {
    const now = await this.clock.now();
    const today = shanghaiBizDate(now);
    const latest = await this.prisma.filingDailyCheck.findFirst({
      orderBy: { bizDate: 'desc' },
    });
    let cursor = today;
    if (latest) {
      cursor = latest.finishedAt ? nextShanghaiDate(latest.bizDate) : latest.bizDate;
    }
    while (cursor <= today) {
      if (now.getTime() < checkInstant(cursor, this.locked.filingDailyCheckTime).getTime()) {
        break;
      }
      await this.runCheck(cursor, now);
      cursor = nextShanghaiDate(cursor);
    }
  }

  private async ensureSubOrders(
    tx: Tx,
    order: { id: bigint; userId: bigint; placedAt: Date },
    paidAt: Date,
  ): Promise<void> {
    const existing = await tx.startupSubOrder.findFirst({ where: { orderId: order.id } });
    if (existing) {
      return;
    }
    const items = await tx.orderItem.findMany({ where: { orderId: order.id } });
    const sorted = [...items].sort((left, right) => compareId(left.id, right.id));
    const unit = this.locked.startupZoneUnitPriceFen;
    for (const item of sorted) {
      if (item.unitPriceFen !== unit) {
        continue;
      }
      for (let index = 0; index < item.quantity; index += 1) {
        await tx.startupSubOrder.create({
          data: {
            orderId: order.id,
            userId: order.userId,
            orderAt: order.placedAt,
            paidAt,
            amountFen: unit,
            filedAt: null,
            createdAt: paidAt,
          },
        });
      }
    }
  }

  private async runCheck(bizDate: string, now: Date): Promise<void> {
    const existing = await this.prisma.filingDailyCheck.findUnique({ where: { bizDate } });
    if (existing?.finishedAt) {
      return;
    }
    if (!existing) {
      try {
        await this.prisma.filingDailyCheck.create({
          data: { bizDate, finishedAt: null, createdAt: now },
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
          SELECT id FROM filing_daily_checks WHERE biz_date = ${bizDate} FOR UPDATE
        `;
        const row = await tx.filingDailyCheck.findUnique({ where: { bizDate } });
        if (row?.finishedAt) {
          return;
        }
        const picks = await this.selectPicks(tx, bizDate);
        for (const pick of picks) {
          await this.fileSubOrder(tx, pick.id, bizDate, now);
        }
        await tx.filingDailyCheck.update({
          where: { bizDate },
          data: { finishedAt: now },
        });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private async selectPicks(tx: Tx, bizDate: string): Promise<SubOrderPick[]> {
    const subs = await tx.startupSubOrder.findMany({ where: { filedAt: null } });
    const filings = await tx.filing.findMany({ where: { bizDate } });
    const filedUsers = new Set(filings.map((filing) => filing.userId.toString()));
    const best = new Map<string, StartupSubOrder>();
    for (const sub of subs) {
      const key = sub.userId.toString();
      if (filedUsers.has(key)) {
        continue;
      }
      const current = best.get(key);
      if (!current || compareSubOrder(sub, current) < 0) {
        best.set(key, sub);
      }
    }
    return [...best.values()]
      .sort(compareSubOrder)
      .map((sub) => ({ id: sub.id, userId: sub.userId, orderAt: sub.orderAt }));
  }

  private async fileSubOrder(
    tx: Tx,
    subOrderId: bigint,
    bizDate: string,
    now: Date,
  ): Promise<void> {
    const sub = await tx.startupSubOrder.findUnique({ where: { id: subOrderId } });
    if (!sub || sub.filedAt) {
      return;
    }
    const already = await tx.filing.findFirst({ where: { userId: sub.userId, bizDate } });
    if (already) {
      return;
    }
    const sequence = await this.nextSequence(tx, now);
    await tx.filing.create({
      data: {
        filingNo: filingNo(bizDate, sequence),
        userId: sub.userId,
        orderId: sub.orderId,
        subOrderId: sub.id,
        sequence,
        bizDate,
        status: FILING_FILED,
        amountFen: this.locked.startupZoneUnitPriceFen,
        filedAt: now,
        settledAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.startupSubOrder.update({
      where: { id: sub.id },
      data: { filedAt: now },
    });
    if (sequence % 5 === 0) {
      await this.settle(tx, sequence, now);
    }
  }

  private async nextSequence(tx: Tx, now: Date): Promise<number> {
    await tx.$queryRaw`
      SELECT id FROM filing_counters WHERE slot = ${COUNTER_SLOT} FOR UPDATE
    `;
    let counter = await tx.filingCounter.findFirst({ where: { slot: COUNTER_SLOT } });
    if (!counter) {
      try {
        counter = await tx.filingCounter.create({
          data: { slot: COUNTER_SLOT, lastSequence: 0, updatedAt: now },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
        counter = await tx.filingCounter.findFirst({ where: { slot: COUNTER_SLOT } });
      }
    }
    if (!counter) {
      throw new InternalServerErrorException('报单序号失败');
    }
    const next = counter.lastSequence + 1;
    await tx.filingCounter.update({
      where: { id: counter.id },
      data: { lastSequence: next, updatedAt: now },
    });
    return next;
  }

  private async settle(tx: Tx, triggerSequence: number, now: Date): Promise<void> {
    const k = triggerSequence / 5;
    const beneficiary = await tx.filing.findFirst({ where: { sequence: k } });
    if (!beneficiary) {
      throw new InternalServerErrorException('报单结算失败');
    }
    const existing = await tx.filingSettlement.findFirst({
      where: { beneficiaryFilingId: beneficiary.id },
    });
    if (existing) {
      return;
    }
    const unit = BigInt(this.locked.startupZoneUnitPriceFen);
    const pointsFen = unit;
    const withdrawableFen = applyBps(unit, this.locked.filingWithdrawalRatioBps);
    await this.credits.creditParts(tx, {
      userId: beneficiary.userId,
      bizType: SOURCE_FILING,
      bizId: `filing:${beneficiary.id.toString()}`,
      rewardType: SOURCE_FILING,
      rewardFen: pointsFen + withdrawableFen,
      now,
      parts: [
        { walletType: WALLET_POINTS, amountFen: pointsFen, sourceCode: null },
        {
          walletType: WALLET_WITHDRAWABLE,
          amountFen: withdrawableFen,
          sourceCode: SOURCE_FILING,
        },
      ],
    });
    await tx.filingSettlement.create({
      data: {
        triggerSequence,
        beneficiaryFilingId: beneficiary.id,
        beneficiaryUserId: beneficiary.userId,
        pointsFen,
        withdrawableFen,
        unitPriceFen: this.locked.startupZoneUnitPriceFen,
        withdrawalRatioBps: this.locked.filingWithdrawalRatioBps,
        settledAt: now,
        createdAt: now,
      },
    });
    await tx.filing.update({
      where: { id: beneficiary.id },
      data: { status: FILING_SETTLED, settledAt: now, updatedAt: now },
    });
    let orderNo = beneficiary.filingNo;
    if (beneficiary.orderId !== null) {
      const order = await tx.order.findUnique({ where: { id: beneficiary.orderId } });
      if (order) {
        orderNo = order.orderNo;
      }
    }
    enqueueNotify({
      type: 'lucky_return_credited',
      userId: beneficiary.userId,
      pointsFen,
      withdrawableFen,
      orderNo,
      occurredAt: now,
    });
    await this.messages.record(
      tx,
      {
        userId: beneficiary.userId,
        category: MESSAGE_CATEGORY_WALLET,
        title: '幸运返还到账',
        body: `订单 ${orderNo} 的幸运返回到账：积分 ${yuanText(pointsFen)}，可提现 ${yuanText(withdrawableFen)}。`,
        linkPage: '/pages/wallet/ledger',
        bizType: 'filing_settlement',
        bizId: beneficiary.id.toString(),
      },
      now,
    );
  }
}

function filingNo(bizDate: string, sequence: number): string {
  return `F${bizDate.replaceAll('-', '')}${String(sequence).padStart(8, '0')}`;
}

function checkInstant(bizDate: string, clockTime: string): Date {
  const [hourRaw, minuteRaw] = clockTime.split(':');
  if (hourRaw === undefined || minuteRaw === undefined) {
    throw new InternalServerErrorException('报单检查时间不正确');
  }
  return shanghaiAt(bizDate, Number(hourRaw), Number(minuteRaw));
}

function smallestId(rows: StartupSubOrder[]): StartupSubOrder | null {
  let chosen: StartupSubOrder | null = null;
  for (const row of rows) {
    if (!chosen || row.id < chosen.id) {
      chosen = row;
    }
  }
  return chosen;
}

function compareSubOrder(
  left: { orderAt: Date; id: bigint },
  right: { orderAt: Date; id: bigint },
): number {
  const time = left.orderAt.getTime() - right.orderAt.getTime();
  if (time !== 0) {
    return time;
  }
  return compareId(left.id, right.id);
}

function compareId(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
