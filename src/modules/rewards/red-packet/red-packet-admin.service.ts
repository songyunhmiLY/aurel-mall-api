import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { USER_STATUS_ACTIVE } from '../../../common/auth/user-status';
import { ClockService } from '../../../common/clock/clock.service';
import { isShanghaiBizDate, shanghaiBizDate } from '../../../common/clock/shanghai-calendar';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  WELFARE_ENTRY_COPY_KEY,
  WELFARE_ENTRY_COPY_MAX,
  WELFARE_ENTRY_IMAGE_KEY,
  WELFARE_ENTRY_IMAGE_MAX,
  WELFARE_POOL_OVERRIDE_MAX_FEN,
} from './red-packet.constants';
import { RedPacketService, type WelfareQuote } from './red-packet.service';

export interface WelfareEntryView {
  copy: string;
  imageUrl: string | null;
}

export interface WelfarePoolOverrideView {
  bizDate: string;
  amountFen: bigint;
  /** 对应日期红包已结算的，设置不会再生效。 */
  settled: boolean;
  updatedAt: Date;
}

export interface WelfareSignupView {
  id: bigint;
  userId: bigint;
  nickname: string;
  bizDate: string;
  signedAt: Date;
  settled: boolean;
  payoutFen: bigint | null;
}

export interface WelfareParticipantView {
  userId: bigint;
  nickname: string;
  member: boolean;
  eligible: boolean;
  actualPayFen: bigint;
  openedRoundCount: number;
  claimCapFen: bigint;
  cumulativeClaimedFen: bigint;
  currentRoundNo: number;
  /** 本轮已领额度。正好领满时落在刚领满的那一轮；超出已开轮次时表示超额已占用尚未开启的下一轮。 */
  currentRoundClaimedFen: bigint;
  signedUpToday: boolean;
}

export interface WelfarePage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 管理端查看报名、资格和本轮已领额度，并维护首页入口文案和图片。
 * K、C 和计提比例不在这里修改。
 */
@Injectable()
export class RedPacketAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly redPackets: RedPacketService,
  ) {}

  async getEntry(): Promise<WelfareEntryView> {
    const [copyRow, imageRow] = await Promise.all([
      this.prisma.adminSetting.findUnique({ where: { settingKey: WELFARE_ENTRY_COPY_KEY } }),
      this.prisma.adminSetting.findUnique({ where: { settingKey: WELFARE_ENTRY_IMAGE_KEY } }),
    ]);
    const image = imageRow?.settingValue ?? '';
    return {
      copy: copyRow?.settingValue ?? '',
      imageUrl: image.length > 0 ? image : null,
    };
  }

  async setEntry(
    input: { copy: string; imageUrl?: string | null },
    adminId: bigint,
  ): Promise<WelfareEntryView> {
    const copy = assertCopy(input.copy);
    const imageUrl = assertImage(input.imageUrl);
    const now = await this.clock.now();
    await this.writeSetting(WELFARE_ENTRY_COPY_KEY, copy, adminId, now);
    await this.writeSetting(WELFARE_ENTRY_IMAGE_KEY, imageUrl, adminId, now);
    return this.getEntry();
  }

  async listPoolOverrides(): Promise<WelfarePoolOverrideView[]> {
    const [overrides, accruals] = await Promise.all([
      this.prisma.redPacketPoolOverride.findMany({ orderBy: { bizDate: 'desc' } }),
      this.prisma.redPacketDailyAccrual.findMany({ orderBy: { bizDate: 'desc' } }),
    ]);
    const settled = new Set(
      accruals.filter((row) => row.settledAt !== null).map((row) => row.bizDate),
    );
    return overrides.map((row) => ({
      bizDate: row.bizDate,
      amountFen: row.amountFen,
      settled: settled.has(row.bizDate),
      updatedAt: row.updatedAt,
    }));
  }

  /** 为指定上海自然日设置固定红包金额池。已结算的日期拒绝设置。 */
  async setPoolOverride(
    input: { bizDate: string; amountFen: string },
    adminId: bigint,
  ): Promise<WelfarePoolOverrideView> {
    const bizDate = assertPoolBizDate(input.bizDate);
    const amountFen = assertPoolAmountFen(input.amountFen);
    const now = await this.clock.now();
    const accrual = await this.prisma.redPacketDailyAccrual.findUnique({
      where: { bizDate },
      select: { settledAt: true },
    });
    if (accrual?.settledAt) {
      throw new BadRequestException('该日期红包已结算，不能再设置金额池');
    }
    await this.prisma.$transaction(async (tx) => {
      // 和结算同一条锁顺序，避免设置金额池和当日结算并发交错。
      await tx.$queryRaw`
        SELECT id FROM red_packet_daily_accruals WHERE biz_date = ${bizDate} FOR UPDATE
      `;
      const accrual = await tx.redPacketDailyAccrual.findUnique({
        where: { bizDate },
        select: { settledAt: true },
      });
      if (accrual?.settledAt) {
        throw new BadRequestException('该日期红包已结算，不能再设置金额池');
      }
      const existing = await tx.redPacketPoolOverride.findUnique({ where: { bizDate } });
      const data = { amountFen, updatedByAdminId: adminId, updatedAt: now };
      if (existing) {
        await tx.redPacketPoolOverride.update({ where: { bizDate }, data });
      } else {
        try {
          await tx.redPacketPoolOverride.create({
            data: { ...data, bizDate, createdAt: now },
          });
        } catch (error) {
          if (!isUniqueConflict(error)) {
            throw error;
          }
          await tx.redPacketPoolOverride.update({ where: { bizDate }, data });
        }
      }
    });
    return { bizDate, amountFen, settled: false, updatedAt: now };
  }

  async deletePoolOverride(bizDateRaw: string): Promise<void> {
    const bizDate = assertPoolBizDate(bizDateRaw);
    try {
      await this.prisma.redPacketPoolOverride.delete({ where: { bizDate } });
    } catch (error) {
      if (isNotFound(error)) {
        throw new NotFoundException('该日期没有设置金额池');
      }
      throw error;
    }
  }

  async listSignups(query: {
    userId?: bigint;
    bizDate?: string;
    page: number;
    pageSize: number;
  }): Promise<WelfarePage<WelfareSignupView>> {
    const where: Prisma.RedPacketSignupWhereInput = {};
    if (query.userId !== undefined) {
      where.userId = query.userId;
    }
    if (query.bizDate !== undefined) {
      where.bizDate = query.bizDate;
    }
    const [total, rows] = await Promise.all([
      this.prisma.redPacketSignup.count({ where }),
      this.prisma.redPacketSignup.findMany({
        where,
        orderBy: [{ bizDate: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    if (rows.length === 0) {
      return { items: [], total, page: query.page, pageSize: query.pageSize };
    }
    const userIds = rows.map((row) => row.userId);
    const bizDates = [...new Set(rows.map((row) => row.bizDate))];
    const [users, accruals, payouts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } } }),
      this.prisma.redPacketDailyAccrual.findMany({ where: { bizDate: { in: bizDates } } }),
      this.prisma.redPacketPayout.findMany({
        where: { userId: { in: userIds }, bizDate: { in: bizDates } },
      }),
    ]);
    const nicknames = new Map(users.map((user) => [user.id.toString(), user.nickname]));
    const settled = new Set(
      accruals.filter((row) => row.settledAt !== null).map((row) => row.bizDate),
    );
    const payoutBySlot = new Map(
      payouts.map((row) => [`${row.userId.toString()}:${row.bizDate}`, row.amountFen]),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        nickname: nicknames.get(row.userId.toString()) ?? '会员',
        bizDate: row.bizDate,
        signedAt: row.signedAt,
        settled: settled.has(row.bizDate),
        payoutFen: payoutBySlot.get(`${row.userId.toString()}:${row.bizDate}`) ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listParticipants(query: {
    userId?: bigint;
    page: number;
    pageSize: number;
  }): Promise<WelfarePage<WelfareParticipantView>> {
    const now = await this.clock.now();
    const bizDate = shanghaiBizDate(now);
    if (query.userId !== undefined) {
      const user = await this.prisma.user.findUnique({ where: { id: query.userId } });
      if (!user) {
        throw new NotFoundException('会员不存在');
      }
      return {
        items: await this.decorate([user], bizDate),
        total: 1,
        page: query.page,
        pageSize: query.pageSize,
      };
    }
    const where: Prisma.UserWhereInput = { member: true };
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: await this.decorate(users, bizDate),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async decorate(users: User[], bizDate: string): Promise<WelfareParticipantView[]> {
    if (users.length === 0) {
      return [];
    }
    const userIds = users.map((user) => user.id);
    const [quotes, signups] = await Promise.all([
      this.redPackets.quotesFor(userIds),
      this.prisma.redPacketSignup.findMany({ where: { userId: { in: userIds }, bizDate } }),
    ]);
    const signed = new Set(signups.map((row) => row.userId.toString()));
    return users.map((user) => {
      const quote = quotes.get(user.id.toString()) ?? emptyQuote();
      return {
        userId: user.id,
        nickname: user.nickname,
        member: user.member,
        eligible: user.member && user.status === USER_STATUS_ACTIVE && quote.moneyEligible,
        actualPayFen: quote.actualPayFen,
        openedRoundCount: countFrom(quote.openedRoundCount),
        claimCapFen: quote.claimCapFen,
        cumulativeClaimedFen: quote.cumulativeClaimedFen,
        currentRoundNo: countFrom(quote.currentRoundNo),
        currentRoundClaimedFen: quote.currentRoundClaimedFen,
        signedUpToday: signed.has(user.id.toString()),
      };
    });
  }

  private async writeSetting(
    settingKey: string,
    settingValue: string,
    adminId: bigint,
    now: Date,
  ): Promise<void> {
    const existing = await this.prisma.adminSetting.findUnique({ where: { settingKey } });
    if (existing) {
      await this.prisma.adminSetting.update({
        where: { id: existing.id },
        data: { settingValue, updatedAt: now, updatedByAdminId: adminId },
      });
      return;
    }
    try {
      await this.prisma.adminSetting.create({
        data: { settingKey, settingValue, updatedAt: now, updatedByAdminId: adminId },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const raced = await this.prisma.adminSetting.findUnique({ where: { settingKey } });
      if (!raced) {
        throw error;
      }
      await this.prisma.adminSetting.update({
        where: { id: raced.id },
        data: { settingValue, updatedAt: now, updatedByAdminId: adminId },
      });
    }
  }
}

function emptyQuote(): WelfareQuote {
  return {
    actualPayFen: 0n,
    cumulativeClaimedFen: 0n,
    openedRoundCount: 0n,
    claimCapFen: 0n,
    currentRoundNo: 0n,
    currentRoundClaimedFen: 0n,
    moneyEligible: false,
  };
}

function countFrom(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InternalServerErrorException('轮次超出范围');
  }
  return Number(value);
}

function assertCopy(copy: string): string {
  if (typeof copy !== 'string') {
    throw new BadRequestException('入口文案不正确');
  }
  const value = copy.trim();
  if (value.length > WELFARE_ENTRY_COPY_MAX) {
    throw new BadRequestException('入口文案过长');
  }
  return value;
}

function assertImage(imageUrl: string | null | undefined): string {
  if (imageUrl === undefined || imageUrl === null) {
    return '';
  }
  if (typeof imageUrl !== 'string') {
    throw new BadRequestException('入口图片地址不正确');
  }
  const value = imageUrl.trim();
  if (value.length > WELFARE_ENTRY_IMAGE_MAX) {
    throw new BadRequestException('入口图片地址过长');
  }
  return value;
}

function assertPoolBizDate(raw: string): string {
  if (typeof raw !== 'string' || !isShanghaiBizDate(raw.trim())) {
    throw new BadRequestException('日期不正确');
  }
  return raw.trim();
}

function assertPoolAmountFen(raw: string): bigint {
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw.trim())) {
    throw new BadRequestException('金额不正确');
  }
  const value = BigInt(raw.trim());
  if (value > BigInt(WELFARE_POOL_OVERRIDE_MAX_FEN)) {
    throw new BadRequestException('金额超出上限');
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
