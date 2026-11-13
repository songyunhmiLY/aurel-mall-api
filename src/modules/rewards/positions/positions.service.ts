import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { PositionDividendPeriod, Prisma } from '@prisma/client';
import { ClockService } from '../../../common/clock/clock.service';
import {
  isShanghaiBizDate,
  isShanghaiBizMonth,
  nextBizMonth,
  previousBizMonth,
  shanghaiBizDate,
  shanghaiBizMonth,
  startOfBizMonth,
} from '../../../common/clock/shanghai-calendar';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../../config/tokens';
import { SettingsService } from '../../settings/settings.service';
import { AwardCreditService } from '../award-credit.service';
import { MarketPerformanceService, type MarketNodeRow } from '../market-performance.service';
import { positionName } from '../position-names';

type Tx = Prisma.TransactionClient;

const PERIOD_OPEN = 'open';
const PERIOD_PAID = 'paid';
const MODE_AUTO = 'auto';
const MODE_MANUAL = 'manual';
const SOURCE = 'position_dividend';
const MAX_FEN = 9223372036854775807n;
const DEFAULT_PAYOUT_DAY = 15;

interface RankSets {
  pools: Array<{ code: string; poolBps: number; exclusive: boolean; userIds: Set<string> }>;
}

export interface DividendPaymentView {
  mode: string;
  actualAmountFen: bigint;
  remark: string | null;
  paidAt: Date;
}

export interface DividendMemberView {
  userId: bigint;
  nickname: string;
  removed: boolean;
  originalAmountFen: bigint;
  payment: DividendPaymentView | null;
}

export interface DividendPoolView {
  positionCode: string;
  positionName: string;
  poolBps: number;
  exclusive: boolean;
  poolFen: bigint;
  eligibleCount: number;
  shareFen: bigint;
  members: DividendMemberView[];
}

export interface DividendPlanView {
  performanceMonth: string;
  payoutMonth: string;
  payoutDate: string;
  status: string;
  thresholdFen: bigint;
  mallPvFen: bigint;
  pools: DividendPoolView[];
}

export interface DividendRecordView {
  id: bigint;
  userId: bigint;
  positionCode: string;
  positionName: string;
  mode: string;
  originalAmountFen: bigint;
  actualAmountFen: bigint;
  remark: string | null;
  paidAt: Date;
}

export interface DividendRecordPage {
  items: DividendRecordView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserQualificationView {
  userId: bigint;
  nickname: string;
  performanceMonth: string;
  thresholdFen: bigint;
  ranks: Array<{
    positionCode: string;
    positionName: string;
    qualified: boolean;
    inPool: boolean;
  }>;
  markets: Array<{ userId: bigint; nickname: string; performanceFen: bigint }>;
}

export interface PositionQualificationCount {
  positionCode: string;
  positionName: string;
  qualifiedCount: number;
}

export interface PositionQualificationCounts {
  performanceMonth: string;
  thresholdFen: bigint;
  counts: PositionQualificationCount[];
}

/**
 * 职位按上海自然月计算，不保留永久任职。
 * 营销经理看直接市场的创业专区已付金额是否达到当月 T。
 * 更高职位看每个直接市场里，有没有至少两名达到上一档的会员。
 * 次月按上月全平台商城 PV 分池。最低一档不含同时达到更高职位的人；更高档包含。
 */
@Injectable()
export class PositionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly settings: SettingsService,
    private readonly performance: MarketPerformanceService,
    private readonly credits: AwardCreditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const now = await this.clock.now();
    let rank = 1;
    for (const tier of this.locked.positionDividendPools) {
      const officialName = positionName(tier.positionCode);
      const existing = await this.prisma.position.findUnique({
        where: { code: tier.positionCode },
      });
      if (!existing) {
        try {
          await this.prisma.position.create({
            data: {
              code: tier.positionCode,
              name: officialName,
              rankLevel: rank,
              createdAt: now,
              updatedAt: now,
            },
          });
        } catch (error) {
          if (!isUniqueConflict(error)) {
            throw error;
          }
        }
      } else if (officialName !== tier.positionCode && existing.name !== officialName) {
        await this.prisma.position.update({
          where: { id: existing.id },
          data: { name: officialName, updatedAt: now },
        });
      }
      rank += 1;
    }
  }

  async runDue(): Promise<void> {
    const now = await this.clock.now();
    const performanceMonth = previousBizMonth(shanghaiBizMonth(now));
    await this.ensurePeriod(performanceMonth, now);
    const today = shanghaiBizDate(now);
    const open = await this.prisma.positionDividendPeriod.findMany({
      where: { status: PERIOD_OPEN },
    });
    for (const period of open) {
      if (period.payoutDate <= today) {
        await this.autoPay(period.performanceMonth, now);
      }
    }
  }

  async preview(month: string | undefined): Promise<DividendPlanView> {
    const now = await this.clock.now();
    const performanceMonth = this.resolveMonth(month, now);
    const period = await this.ensurePeriod(performanceMonth, now);
    return this.assemble(period);
  }

  async changePayoutDate(month: string, payoutDate: string): Promise<DividendPlanView> {
    if (!isShanghaiBizDate(payoutDate)) {
      throw new BadRequestException('发放日不正确');
    }
    const now = await this.clock.now();
    const performanceMonth = this.resolveMonth(month, now);
    const period = await this.ensurePeriod(performanceMonth, now);
    if (period.status === PERIOD_PAID) {
      throw new ConflictException('本期已发放，不能修改发放日');
    }
    const payoutMonth = nextBizMonth(performanceMonth);
    if (!payoutDate.startsWith(`${payoutMonth}-`)) {
      throw new BadRequestException('发放日必须在业绩月的次月');
    }
    const today = shanghaiBizDate(now);
    if (payoutDate <= today) {
      throw new BadRequestException('只能改到尚未到来的发放日');
    }
    const updated = await this.prisma.positionDividendPeriod.update({
      where: { id: period.id },
      data: { payoutDate, updatedAt: now },
    });
    return this.assemble(updated);
  }

  async exclude(month: string, userId: bigint, adminId: bigint): Promise<DividendPlanView> {
    const now = await this.clock.now();
    const performanceMonth = this.resolveMonth(month, now);
    const period = await this.ensurePeriod(performanceMonth, now);
    if (period.status === PERIOD_PAID) {
      throw new ConflictException('本期已发放，不能移除');
    }
    const plan = await this.compute(performanceMonth);
    if (!memberInPlan(plan, userId)) {
      throw new BadRequestException('该会员不在本期自动发放名单');
    }
    const existing = await this.prisma.positionDividendExclusion.findFirst({
      where: { periodId: period.id, userId },
    });
    if (!existing) {
      await this.prisma.positionDividendExclusion.create({
        data: {
          periodId: period.id,
          userId,
          removedByAdminId: adminId,
          removedAt: now,
          createdAt: now,
        },
      });
    }
    return this.assemble(period);
  }

  async payManually(
    month: string,
    input: { userId: bigint; positionCode: string; actualAmountFen: bigint; remark: string },
    adminId: bigint,
  ): Promise<DividendRecordView> {
    const remark = input.remark.trim();
    if (remark.length < 1 || remark.length > 200) {
      throw new BadRequestException('请填写备注');
    }
    if (input.actualAmountFen < 0n || input.actualAmountFen > MAX_FEN) {
      throw new BadRequestException('金额不正确');
    }
    const now = await this.clock.now();
    const performanceMonth = this.resolveMonth(month, now);
    const period = await this.ensurePeriod(performanceMonth, now);
    const exclusion = await this.prisma.positionDividendExclusion.findFirst({
      where: { periodId: period.id, userId: input.userId },
    });
    if (!exclusion) {
      throw new BadRequestException('该会员未停止自动发放');
    }
    const plan = await this.compute(performanceMonth);
    const pool = plan.pools.find((item) => item.positionCode === input.positionCode);
    const member = pool?.members.find((item) => item.userId === input.userId);
    if (!pool || !member) {
      throw new BadRequestException('该会员不在这个职位的发放名单');
    }
    const existing = await this.prisma.positionDividendRecord.findFirst({
      where: { periodId: period.id, userId: input.userId, positionCode: input.positionCode },
    });
    if (existing) {
      throw new ConflictException('该职位已经发放');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.credits.creditSplit(tx, {
        userId: input.userId,
        amountFen: input.actualAmountFen,
        split: this.locked.mallAwardSplit,
        bizType: SOURCE,
        bizId: recordBiz(period.id, input.positionCode, MODE_MANUAL),
        sourceCode: SOURCE,
        now,
      });
      await tx.positionDividendRecord.create({
        data: {
          periodId: period.id,
          userId: input.userId,
          positionCode: input.positionCode,
          mode: MODE_MANUAL,
          originalAmountFen: member.originalAmountFen,
          actualAmountFen: input.actualAmountFen,
          remark,
          adminId,
          paidAt: now,
          createdAt: now,
        },
      });
    });
    const saved = await this.prisma.positionDividendRecord.findFirst({
      where: { periodId: period.id, userId: input.userId, positionCode: input.positionCode },
    });
    if (!saved) {
      throw new NotFoundException('发放记录不存在');
    }
    return toRecord(saved);
  }

  async qualification(userId: bigint, month: string | undefined): Promise<UserQualificationView> {
    const now = await this.clock.now();
    const performanceMonth = this.resolveMonth(month, now);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const from = startOfBizMonth(performanceMonth);
    const until = startOfBizMonth(nextBizMonth(performanceMonth));
    const nodes = await this.performance.loadNodes();
    const startup = await this.performance.startupPaidByUser(
      nodes.map((node) => node.userId),
      from,
      until,
    );
    const thresholdFen = await this.settings.thresholdForMonth(performanceMonth);
    const users = await this.prisma.user.findMany();
    const nicknames = new Map(users.map((row) => [row.id.toString(), row.nickname]));
    const sets = this.qualifiedSets(nodes, startup, thresholdFen);
    const key = userId.toString();
    const ranks = this.locked.positionDividendPools.map((tier, index) => ({
      positionCode: tier.positionCode,
      positionName: positionName(tier.positionCode),
      qualified: sets[index]?.has(key) ?? false,
      inPool:
        index === 0
          ? (sets[0]?.has(key) ?? false) && !sets.slice(1).some((set) => set.has(key))
          : (sets[index]?.has(key) ?? false),
    }));
    const markets = this.performance.directChildren(nodes, userId).map((market) => ({
      userId: market.userId,
      nickname: nicknames.get(market.userId.toString()) ?? '会员',
      performanceFen: this.performance.sumUsers(
        startup,
        this.performance.subtreeUserIds(nodes, market),
      ),
    }));
    return {
      userId,
      nickname: user.nickname,
      performanceMonth,
      thresholdFen,
      ranks,
      markets,
    };
  }

  /**
   * 某一自然月各档资格人数。允许尚未结束的当前月。
   * 门槛用该月已经生效的 T，达标规则与职位分红相同。
   * 不计算池金额，也不因为月份未结束而拒绝。
   */
  async qualificationCounts(performanceMonth: string): Promise<PositionQualificationCounts> {
    if (!isShanghaiBizMonth(performanceMonth)) {
      throw new BadRequestException('月份不正确');
    }
    const from = startOfBizMonth(performanceMonth);
    const until = startOfBizMonth(nextBizMonth(performanceMonth));
    const nodes = await this.performance.loadNodes();
    const startup = await this.performance.startupPaidByUser(
      nodes.map((node) => node.userId),
      from,
      until,
    );
    const thresholdFen = await this.settings.thresholdForMonth(performanceMonth);
    const sets = this.qualifiedSets(nodes, startup, thresholdFen);
    return {
      performanceMonth,
      thresholdFen,
      counts: this.locked.positionDividendPools.map((tier, index) => ({
        positionCode: tier.positionCode,
        positionName: positionName(tier.positionCode),
        qualifiedCount: sets[index]?.size ?? 0,
      })),
    };
  }

  async listRecords(month: string, page: number, pageSize: number): Promise<DividendRecordPage> {
    const now = await this.clock.now();
    const performanceMonth = this.resolveMonth(month, now);
    const period = await this.ensurePeriod(performanceMonth, now);
    const where = { periodId: period.id };
    const [total, rows] = await Promise.all([
      this.prisma.positionDividendRecord.count({ where }),
      this.prisma.positionDividendRecord.findMany({
        where,
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toRecord), total, page, pageSize };
  }

  private resolveMonth(month: string | undefined, now: Date): string {
    const performanceMonth = month ?? previousBizMonth(shanghaiBizMonth(now));
    if (performanceMonth >= shanghaiBizMonth(now)) {
      throw new BadRequestException('业绩月份尚未结束');
    }
    return performanceMonth;
  }

  private async ensurePeriod(performanceMonth: string, now: Date): Promise<PositionDividendPeriod> {
    const existing = await this.prisma.positionDividendPeriod.findUnique({
      where: { performanceMonth },
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.prisma.positionDividendPeriod.create({
        data: {
          performanceMonth,
          payoutDate: `${nextBizMonth(performanceMonth)}-${String(DEFAULT_PAYOUT_DAY).padStart(2, '0')}`,
          status: PERIOD_OPEN,
          mallPvFen: null,
          autoPaidAt: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const raced = await this.prisma.positionDividendPeriod.findUnique({
        where: { performanceMonth },
      });
      if (!raced) {
        throw new NotFoundException('分红周期不存在');
      }
      return raced;
    }
  }

  private async autoPay(performanceMonth: string, now: Date): Promise<void> {
    const period = await this.prisma.positionDividendPeriod.findUnique({
      where: { performanceMonth },
    });
    if (!period || period.status === PERIOD_PAID) {
      return;
    }
    const plan = await this.compute(performanceMonth);
    const exclusions = await this.prisma.positionDividendExclusion.findMany({
      where: { periodId: period.id },
    });
    const removed = new Set(exclusions.map((row) => row.userId.toString()));
    for (const pool of plan.pools) {
      for (const member of pool.members) {
        if (removed.has(member.userId.toString())) {
          continue;
        }
        await this.prisma.$transaction((tx) => this.writeAuto(tx, period.id, pool, member, now));
      }
    }
    await this.prisma.positionDividendPeriod.updateMany({
      where: { id: period.id, status: PERIOD_OPEN },
      data: {
        status: PERIOD_PAID,
        mallPvFen: plan.mallPvFen,
        autoPaidAt: now,
        updatedAt: now,
      },
    });
  }

  private async writeAuto(
    tx: Tx,
    periodId: bigint,
    pool: DividendPoolView,
    member: DividendMemberView,
    now: Date,
  ): Promise<void> {
    const existing = await tx.positionDividendRecord.findFirst({
      where: { periodId, userId: member.userId, positionCode: pool.positionCode },
    });
    if (existing) {
      return;
    }
    await this.credits.creditSplit(tx, {
      userId: member.userId,
      amountFen: member.originalAmountFen,
      split: this.locked.mallAwardSplit,
      bizType: SOURCE,
      bizId: recordBiz(periodId, pool.positionCode, MODE_AUTO),
      sourceCode: SOURCE,
      now,
    });
    await tx.positionDividendRecord.create({
      data: {
        periodId,
        userId: member.userId,
        positionCode: pool.positionCode,
        mode: MODE_AUTO,
        originalAmountFen: member.originalAmountFen,
        actualAmountFen: member.originalAmountFen,
        remark: null,
        adminId: null,
        paidAt: now,
        createdAt: now,
      },
    });
  }

  private async assemble(period: PositionDividendPeriod): Promise<DividendPlanView> {
    const plan = await this.compute(period.performanceMonth);
    const [exclusions, records, users] = await Promise.all([
      this.prisma.positionDividendExclusion.findMany({ where: { periodId: period.id } }),
      this.prisma.positionDividendRecord.findMany({ where: { periodId: period.id } }),
      this.prisma.user.findMany(),
    ]);
    const removed = new Set(exclusions.map((row) => row.userId.toString()));
    const recordKey = (userId: bigint, code: string) => `${userId.toString()}:${code}`;
    const recordBySlot = new Map(
      records.map((row) => [recordKey(row.userId, row.positionCode), row]),
    );
    const nicknames = new Map(users.map((user) => [user.id.toString(), user.nickname]));
    return {
      performanceMonth: period.performanceMonth,
      payoutMonth: nextBizMonth(period.performanceMonth),
      payoutDate: period.payoutDate,
      status: period.status,
      thresholdFen: plan.thresholdFen,
      mallPvFen: plan.mallPvFen,
      pools: plan.pools.map((pool) => ({
        ...pool,
        members: pool.members.map((member) => {
          const record = recordBySlot.get(recordKey(member.userId, pool.positionCode));
          return {
            userId: member.userId,
            nickname: nicknames.get(member.userId.toString()) ?? '会员',
            removed: removed.has(member.userId.toString()),
            originalAmountFen: member.originalAmountFen,
            payment: record
              ? {
                  mode: record.mode,
                  actualAmountFen: record.actualAmountFen,
                  remark: record.remark,
                  paidAt: record.paidAt,
                }
              : null,
          };
        }),
      })),
    };
  }

  private async compute(performanceMonth: string): Promise<DividendPlanView> {
    const from = startOfBizMonth(performanceMonth);
    const until = startOfBizMonth(nextBizMonth(performanceMonth));
    const nodes = await this.performance.loadNodes();
    const userIds = nodes.map((node) => node.userId);
    const [startup, mallPvFen, thresholdFen, users] = await Promise.all([
      this.performance.startupPaidByUser(userIds, from, until),
      this.performance.platformMallPv(from, until),
      this.settings.thresholdForMonth(performanceMonth),
      this.prisma.user.findMany(),
    ]);
    const ranks = this.rankSets(nodes, startup, thresholdFen);
    const nicknames = new Map(users.map((user) => [user.id.toString(), user.nickname]));
    const pools = ranks.pools.map((pool) => {
      const poolFen = (mallPvFen * BigInt(pool.poolBps)) / 10_000n;
      const eligible = [...pool.userIds].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const shareFen = eligible.length === 0 ? 0n : poolFen / BigInt(eligible.length);
      return {
        positionCode: pool.code,
        positionName: positionName(pool.code),
        poolBps: pool.poolBps,
        exclusive: pool.exclusive,
        poolFen,
        eligibleCount: eligible.length,
        shareFen,
        members: eligible.map((id) => ({
          userId: BigInt(id),
          nickname: nicknames.get(id) ?? '会员',
          removed: false,
          originalAmountFen: shareFen,
          payment: null,
        })),
      };
    });
    return {
      performanceMonth,
      payoutMonth: nextBizMonth(performanceMonth),
      payoutDate: '',
      status: PERIOD_OPEN,
      thresholdFen,
      mallPvFen,
      pools,
    };
  }

  private qualifiedSets(
    nodes: MarketNodeRow[],
    startup: Map<string, bigint>,
    thresholdFen: bigint,
  ): Array<Set<string>> {
    const tiers = this.locked.positionDividendPools;
    if (tiers.length === 0) {
      return [];
    }
    const qualified: Array<Set<string>> = [this.baseRank(nodes, startup, thresholdFen)];
    for (let index = 1; index < tiers.length; index += 1) {
      const previous = qualified[index - 1] ?? new Set<string>();
      qualified.push(this.nextRank(nodes, previous));
    }
    return qualified;
  }

  private rankSets(
    nodes: MarketNodeRow[],
    startup: Map<string, bigint>,
    thresholdFen: bigint,
  ): RankSets {
    const tiers = this.locked.positionDividendPools;
    const qualified = this.qualifiedSets(nodes, startup, thresholdFen);
    const base = tiers[0];
    if (!base) {
      return { pools: [] };
    }
    const higher = new Set<string>();
    for (let index = 1; index < qualified.length; index += 1) {
      for (const userId of qualified[index] ?? []) {
        higher.add(userId);
      }
    }
    return {
      pools: tiers.map((tier, index) => {
        const holders = qualified[index] ?? new Set<string>();
        if (index === 0) {
          const exclusive = new Set<string>();
          for (const userId of holders) {
            if (!higher.has(userId)) {
              exclusive.add(userId);
            }
          }
          return {
            code: tier.positionCode,
            poolBps: tier.poolBps,
            exclusive: true,
            userIds: exclusive,
          };
        }
        return {
          code: tier.positionCode,
          poolBps: tier.poolBps,
          exclusive: false,
          userIds: holders,
        };
      }),
    };
  }

  private baseRank(
    nodes: MarketNodeRow[],
    startup: Map<string, bigint>,
    thresholdFen: bigint,
  ): Set<string> {
    const result = new Set<string>();
    for (const node of nodes) {
      const children = this.performance.directChildren(nodes, node.userId);
      let markets = 0;
      for (const child of children) {
        const total = this.performance.sumUsers(
          startup,
          this.performance.subtreeUserIds(nodes, child),
        );
        if (total >= thresholdFen) {
          markets += 1;
        }
      }
      if (markets >= 2) {
        result.add(node.userId.toString());
      }
    }
    return result;
  }

  private nextRank(nodes: MarketNodeRow[], previous: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const node of nodes) {
      const children = this.performance.directChildren(nodes, node.userId);
      let markets = 0;
      for (const child of children) {
        let count = 0;
        for (const userId of this.performance.subtreeUserIds(nodes, child)) {
          if (previous.has(userId.toString())) {
            count += 1;
          }
        }
        if (count >= 2) {
          markets += 1;
        }
      }
      if (markets >= 2) {
        result.add(node.userId.toString());
      }
    }
    return result;
  }
}

function memberInPlan(plan: DividendPlanView, userId: bigint): boolean {
  return plan.pools.some((pool) => pool.members.some((member) => member.userId === userId));
}

function recordBiz(periodId: bigint, positionCode: string, mode: string): string {
  return `period:${periodId.toString()}:${positionCode}:${mode}`;
}

function toRecord(row: {
  id: bigint;
  userId: bigint;
  positionCode: string;
  mode: string;
  originalAmountFen: bigint;
  actualAmountFen: bigint;
  remark: string | null;
  paidAt: Date;
}): DividendRecordView {
  return {
    id: row.id,
    userId: row.userId,
    positionCode: row.positionCode,
    positionName: positionName(row.positionCode),
    mode: row.mode,
    originalAmountFen: row.originalAmountFen,
    actualAmountFen: row.actualAmountFen,
    remark: row.remark,
    paidAt: row.paidAt,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
