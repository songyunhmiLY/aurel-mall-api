import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import {
  addShanghaiDays,
  nextShanghaiDate,
  shanghaiAt,
  shanghaiBizDate,
  startOfShanghaiDay,
} from '../../common/clock/shanghai-calendar';
import { hashPassword } from '../../common/auth/password-hasher';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { DueJobRunner } from '../../jobs/due-job.runner';
import { IDENTITY_PROVIDERS } from '../users/identity.constants';
import { UsersService } from '../users/users.service';
import { ROOT_INVITE_CODE } from '../users/identity.constants';
import { CofounderPayService } from '../cofounder/cofounder-pay.service';
import { CofounderEnrollmentService } from '../cofounder/cofounder-enrollment.service';
import { CofounderSettingsService } from '../cofounder/cofounder-settings.service';
import {
  COFOUNDER_STATUS_ACTIVE,
  PAYOUT_PERIODIC,
} from '../cofounder/cofounder.constants';
import { OpsTeamEnrollmentService } from '../ops-team/ops-team-enrollment.service';
import { OPS_TEAM_STATUS_ACTIVE } from '../ops-team/ops-team.constants';
import { StudioEnrollmentService } from '../studio/studio-enrollment.service';
import { STUDIO_STATUS_ACTIVE } from '../studio/studio.constants';
import {
  COMPENSATION_AUTO_RETRY,
  COMPENSATION_AWAITING_OPERATION,
} from '../orders/settlement-compensation.constants';
import { OrdersService } from '../orders/orders.service';
import { WITHDRAWAL_PENDING } from '../wallet/wallet.constants';
import { WechatPayService } from '../payments/wechat-pay.service';
import { applyBps } from '../rewards/award-split';
import { RedPacketService } from '../rewards/red-packet/red-packet.service';
import { WELFARE_POOL_OVERRIDE_MAX_FEN } from '../rewards/red-packet/red-packet.constants';
import { PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import {
  SIMULATION_STORE,
  type SimulationDiff,
  type SimulationEvent,
  type SimulationFilingInfo,
  type SimulationLedgerEntry,
  type SimulationOverview,
  type SimulationRedPacketPool,
  type SimulationRedPacketPoolContext,
  type SimulationSnapshot,
  type SimulationStatus,
  type SimulationStore,
  type SimulationTreeEdge,
  type SimulationTreeUser,
  type SimulationUnfiledOrder,
  type SimulationUsersTree,
} from './simulation.types';

const WALLET_POINTS = 'points';
const WALLET_WITHDRAWABLE = 'withdrawable';
const WALLET_CONSUMPTION = 'consumption';

const ROLE_COFOUNDER = 'cofounder';
const ROLE_STUDIO = 'studio';

const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MAX_ADVANCE_DAYS = 180;

/** 演练用户统一支付密码：消费划转、提现等资金操作校验用。 */
const SEED_PAYMENT_PASSWORD = '123456';

/** 演练命名规则：L{层}·{路径}·父{父路径}·邀{邀请人路径}，第二段是树路径。 */
const TREE_NICKNAME_PATTERN = /^L\d+·([A-Za-z]+)·/;

const MAX_BATCH_USERS = 200;

let eventSeq = 0;

export interface SimulatedPurchaseResult {
  userId: string;
  nickname: string;
  ok: boolean;
  orderId: string | null;
  orderNo: string | null;
  quantity: number;
  payAmountFen: number;
  status: string | null;
  /** 本单支付后是否当场完成报单（按日每人一笔）。 */
  filed: boolean;
  error: string | null;
}

export interface SimulatedRoleResult {
  userId: string;
  nickname: string;
  role: string;
  ok: boolean;
  /** 联合创始人走付费开通时有付款记录。 */
  payNo: string | null;
  error: string | null;
}

export interface SimulatedRedPacketSignupResult {
  userId: string;
  nickname: string;
  /** signed=本次报名成功；already=当天已报过；skipped=没报上。 */
  outcome: 'signed' | 'already' | 'skipped';
  /** skipped 时的原因。 */
  error: string | null;
}

/**
 * 时间仿真台。
 * 1. 时钟：设置/清除覆盖，单步推进，逐业务日推进；
 * 2. 造数：批量注册、批量购买创业专区/会员商城、红包报名、任命角色；
 * 3. 观测：总览、时间轴、每步账务差分；
 * 4. 重置：清空业务数据，保留商品与系统配置。
 *
 * 只在非正式环境启用：env.simulationEnabled=false 时所有操作都拒绝。
 * 造数走的是正式业务服务（下单、支付、报单、入座、角色开通、红包报名），不是伪造行。
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    private readonly clock: ClockService,
    private readonly runner: DueJobRunner,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly orders: OrdersService,
    private readonly wechat: WechatPayService,
    private readonly cofounderPay: CofounderPayService,
    private readonly cofounderSettings: CofounderSettingsService,
    private readonly cofounders: CofounderEnrollmentService,
    private readonly studios: StudioEnrollmentService,
    private readonly opsTeam: OpsTeamEnrollmentService,
    private readonly redPackets: RedPacketService,
    @Inject(SIMULATION_STORE) private readonly store: SimulationStore,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async status(): Promise<SimulationStatus> {
    this.assertEnabled();
    const view = await this.clock.readOverride();
    const timeline = await this.store.list();
    return {
      clock: {
        allowed: view.allowed,
        source: view.source,
        now: view.now,
        override: view.override,
      },
      timelineCount: timeline.length,
    };
  }

  async overview(): Promise<SimulationOverview> {
    this.assertEnabled();
    const clock = await this.clock.resolve();
    const [
      total,
      members,
      orderCount,
      paid,
      cofounders,
      studios,
      opsTeam,
      completedFilings,
      settledFilings,
      unfiledRows,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { member: true } }),
      this.prisma.order.count(),
      this.prisma.order.aggregate({
        where: { status: { in: ['paid', 'shipped'] } },
        _count: true,
        _sum: { payAmountFen: true },
      }),
      this.prisma.cofounderEnrollment.count({ where: { status: COFOUNDER_STATUS_ACTIVE } }),
      this.prisma.studioEnrollment.count({ where: { status: STUDIO_STATUS_ACTIVE } }),
      this.prisma.opsTeamEnrollment.count({ where: { status: OPS_TEAM_STATUS_ACTIVE } }),
      this.prisma.filing.count({ where: { sequence: { not: null } } }),
      this.prisma.filing.findMany({
        where: { status: 'settled' },
        orderBy: { sequence: 'asc' },
      }),
      this.prisma.startupSubOrder.findMany({ where: { filedAt: null } }),
    ]);
    const settledSequences = settledFilings
      .map((row) => row.sequence)
      .filter((value): value is number => value !== null);
    // 一单多件会拆成多条创业子单，按子单数计数才能反映真实待报单量。
    const unfiledSubOrders = unfiledRows.length;
    return {
      clock: {
        now: clock.now.toISOString(),
        realNow: clock.realNow.toISOString(),
        source: clock.source,
      },
      users: { total, members },
      orders: {
        total: orderCount,
        paid: paid._count,
        paidAmountFen: paid._sum.payAmountFen ?? 0,
      },
      roles: { cofounders, studios, opsTeam },
      filings: { completed: completedFilings, settledSequences, unfiledSubOrders },
      businessDate: shanghaiBizDate(clock.now),
    };
  }

  async setClock(iso: string): Promise<SimulationStatus> {
    this.assertEnabled();
    const before = await this.clock.readOverride();
    const view = await this.clock.setOverride(iso);
    await this.append('set_clock', {
      from: before.override ?? before.now,
      to: view.override,
    });
    return this.status();
  }

  async clearClock(): Promise<SimulationStatus> {
    this.assertEnabled();
    const before = await this.clock.readOverride();
    await this.clock.clearOverride();
    await this.append('clear_clock', { from: before.override });
    return this.status();
  }

  /**
   * 单步推进。to 是目标时刻（ISO）；byMinutes 是从当前仿真时刻往前推的分钟数。
   * 两者都缺省时推进到真实当前时间（把仿真时间"追平"现实）。
   * 推进后按序触发一次全部到期 job，并记录账务差分。
   */
  async step(input: { to?: string; byMinutes?: number }): Promise<{
    status: SimulationStatus;
    event: SimulationEvent;
  }> {
    this.assertEnabled();
    const view = await this.clock.readOverride();
    if (!view.allowed) {
      throw new BadRequestException('时间仿真未启用（ALLOW_CLOCK_OVERRIDE=false）');
    }
    if (view.source !== 'override') {
      throw new BadRequestException('请先设置仿真时钟起点，再单步推进');
    }
    const target = await this.resolveTarget(view.override as string, input);
    if (target.getTime() <= Date.parse(view.now)) {
      throw new BadRequestException('目标时刻必须晚于当前仿真时刻');
    }
    await this.clock.setOverride(target.toISOString());

    const before = await this.snapshot();
    await this.runner.runDue();
    const after = await this.snapshot();
    const diff = diffOf(before, after);

    const event = await this.append(
      'step',
      {
        from: view.override,
        to: target.toISOString(),
        byMinutes: input.byMinutes,
        jobsAttempted: true,
      },
      diff,
    );
    return { status: await this.status(), event };
  }

  /**
   * 逐业务日推进。从当前仿真时刻到目标时刻，先收集这段区间内的全部计划档位
   * （可能跨多天，每天多档），逐档把时钟推到档位时刻、跑一次到期任务，全部
   * 档位完成后把仿真时钟（即下一次推进的起点）停在目标时刻：
   * 报单检查与红包结算用 env 配置的每日报单钟点，联合创始人定期分配用管理端配置的
   * 钟点，按业务日判定的任务在 23:59 兜底——钟点与真实环境一致，任务记录的时间戳
   * 就是它的计划时刻。任务执行本身按真实耗时计：runDue 的墙钟耗时（毫秒级）会
   * 加到仿真时钟上，模拟真实环境里任务占用的时间；若耗时压到了下一档位，下一档
   * 顺延执行。目标时刻本身再兜底跑一次，覆盖落在非整点的定时策略。只能往后推进。
   */
  async advance(input: { to: string; redPacketPoolFen?: string }): Promise<{
    status: SimulationStatus;
    event: SimulationEvent;
    steps: number;
    /** 本次推进填写的红包池，以及它是否真的被结算用上。 */
    redPacketPool: SimulationRedPacketPool | null;
  }> {
    this.assertEnabled();
    const view = await this.clock.readOverride();
    if (view.source !== 'override') {
      throw new BadRequestException('请先设置仿真时钟起点，再推进时间');
    }
    const from = this.clock.instant(Date.parse(view.now));
    const targetMs = Date.parse(input.to);
    if (Number.isNaN(targetMs)) {
      throw new BadRequestException('无效的 ISO 时间');
    }
    const target = this.clock.instant(targetMs);
    if (target.getTime() <= from.getTime()) {
      throw new BadRequestException('目标时刻必须晚于当前仿真时刻');
    }
    const dayCount = Math.ceil((target.getTime() - from.getTime()) / 86_400_000);
    if (dayCount > MAX_ADVANCE_DAYS) {
      throw new BadRequestException(`单次最多推进 ${MAX_ADVANCE_DAYS} 天`);
    }

    // 演练填写的红包池只给「当前仿真日」用：这一天会在本次推进跨过次日结算钟点时结算。
    const poolFen = this.parseRedPacketPoolFen(input.redPacketPoolFen);
    const poolBizDate = poolFen === null ? null : shanghaiBizDate(from);
    const jobOptions =
      poolFen === null || poolBizDate === null
        ? undefined
        : { redPacketPool: { bizDate: poolBizDate, amountFen: poolFen } };

    const slots = await this.collectDailySlotTimes();
    const before = await this.snapshot();
    let steps = 0;
    // 上一档位「任务执行结束」的时刻；后续档位若被压到，从这个时刻起跑。
    let lastEnd = from.getTime();
    let cursor = startOfShanghaiDay(from);
    const lastDay = startOfShanghaiDay(target).getTime();
    while (cursor.getTime() <= lastDay) {
      const bizDate = shanghaiBizDate(cursor);
      for (const slot of slots) {
        const instant = shanghaiAt(bizDate, slot.hour, slot.minute);
        if (instant.getTime() <= from.getTime() || instant.getTime() > target.getTime()) {
          continue;
        }
        const startAt = Math.max(instant.getTime(), lastEnd);
        await this.clock.setOverride(this.clock.instant(startAt).toISOString());
        const wallStart = performance.now();
        await this.runner.runDue(jobOptions);
        // 任务的真实执行耗时（哪怕只有几毫秒）体现到仿真时钟上。
        const elapsedMs = Math.round(performance.now() - wallStart);
        lastEnd = Math.max(lastEnd, startAt + elapsedMs);
        await this.clock.setOverride(this.clock.instant(lastEnd).toISOString());
        steps += 1;
      }
      cursor = addShanghaiDays(cursor, 1);
    }
    // 全部档位完成后，把仿真起点停在目标时刻；仅当任务耗时意外越过了目标时停在任务结束后。
    const finalAt = Math.max(target.getTime(), lastEnd);
    await this.clock.setOverride(this.clock.instant(finalAt).toISOString());
    await this.runner.runDue(jobOptions);
    steps += 1;

    const redPacketPool = await this.describeAdvancePool(poolBizDate, poolFen);
    const diff = diffOf(before, await this.snapshot());
    const event = await this.append(
      'advance',
      {
        from: view.override,
        to: this.clock.instant(finalAt).toISOString(),
        steps,
        ...(redPacketPool
          ? {
              redPacketBizDate: redPacketPool.bizDate,
              redPacketPoolFen: redPacketPool.amountFen,
              redPacketApplied: redPacketPool.applied,
            }
          : {}),
      },
      diff,
    );
    this.logger.log(
      `simulation advanced ${view.override} -> ${this.clock.instant(finalAt).toISOString()} (${steps} steps)`,
    );
    return { status: await this.status(), event, steps, redPacketPool };
  }

  /**
   * 演练页「红包池」上下文：显示当前仿真日会按什么规则结算，以及后台有没有
   * 为这一天设置金额。settleAt 是这一天真正结算的时刻（次日检查钟点）。
   */
  async redPacketPoolContext(): Promise<SimulationRedPacketPoolContext> {
    this.assertEnabled();
    const now = await this.clock.now();
    const bizDate = shanghaiBizDate(now);
    const nextDate = nextShanghaiDate(bizDate);
    const { hour, minute } = this.dailyCheckTime();
    const from = shanghaiAt(bizDate, 0, 0);
    const until = shanghaiAt(nextDate, 0, 0);
    const [accrual, override, signupCount, paidOrders] = await Promise.all([
      this.prisma.redPacketDailyAccrual.findUnique({ where: { bizDate } }),
      this.prisma.redPacketPoolOverride.findUnique({ where: { bizDate } }),
      this.prisma.redPacketSignup.count({ where: { bizDate } }),
      this.prisma.order.findMany({
        where: {
          zone: PRODUCT_ZONE_STARTUP,
          status: { in: ['paid', 'shipped'] },
          paidAt: { gte: from, lt: until },
        },
      }),
    ]);
    let salesFen = 0n;
    for (const order of paidOrders) {
      salesFen += BigInt(order.goodsTotalFen);
    }
    return {
      bizDate,
      settleAt: shanghaiAt(nextDate, hour, minute).toISOString(),
      settled: accrual?.settledAt != null,
      adminAmountFen: override ? override.amountFen.toString() : null,
      signupCount,
      accrualBps: this.env.locked.redPacketDailyAccrualBps,
      salesFen: salesFen.toString(),
      defaultPoolFen: applyBps(salesFen, this.env.locked.redPacketDailyAccrualBps).toString(),
    };
  }

  private parseRedPacketPoolFen(value: string | undefined): bigint | null {
    if (value === undefined || value === '') {
      return null;
    }
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('红包池金额不正确');
    }
    const fen = BigInt(value);
    if (fen > BigInt(WELFARE_POOL_OVERRIDE_MAX_FEN)) {
      throw new BadRequestException('红包池金额超出上限');
    }
    return fen;
  }

  /** 只有本次推进真的结算了该业务日，填写的金额才算用上。 */
  private async describeAdvancePool(
    bizDate: string | null,
    poolFen: bigint | null,
  ): Promise<SimulationRedPacketPool | null> {
    if (bizDate === null || poolFen === null) {
      return null;
    }
    const accrual = await this.prisma.redPacketDailyAccrual.findUnique({ where: { bizDate } });
    return {
      bizDate,
      amountFen: poolFen.toString(),
      applied: accrual?.settledAt != null,
    };
  }

  private dailyCheckTime(): { hour: number; minute: number } {
    const [hourRaw, minuteRaw] = this.env.locked.filingDailyCheckTime.split(':');
    return { hour: Number(hourRaw), minute: Number(minuteRaw) };
  }

  /**
   * 一天里要跑到期任务的计划钟点，按时刻升序。与真实环境的调度配置一致：
   * - 报单检查与红包结算共用 env 的每日报单钟点（filingDailyCheckTime）；
   * - 联合创始人定期分配用管理端配置的发放钟点（周期不是每日时，非到期日
   *   会由服务内部判定跳过，不会误触发）；
   * - 23:59 是按业务日判定的任务的兜底档位。
   */
  private async collectDailySlotTimes(): Promise<{ hour: number; minute: number }[]> {
    const times = new Set<string>([this.env.locked.filingDailyCheckTime, '23:59']);
    const settings = await this.cofounderSettings.get();
    if (settings.payoutMode === PAYOUT_PERIODIC && CLOCK_TIME_PATTERN.test(settings.schedule.time)) {
      times.add(settings.schedule.time);
    }
    const slots: { hour: number; minute: number }[] = [];
    for (const time of times) {
      const match = CLOCK_TIME_PATTERN.exec(time);
      if (match) {
        slots.push({ hour: Number(match[1]), minute: Number(match[2]) });
      }
    }
    slots.sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute));
    return slots;
  }

  /**
   * 批量注册仿真用户，昵称按演练命名规则生成：
   * `L{层}·{邀请路径}{序号}·邀{邀请人路径}`，序号是 26 进制小写 a、b、…、z、aa…。
   * 路径大写字母段是市场树（A/B/C = 左/中/右），小写段是邀请谱系。
   * 每个用户都带上统一支付密码（SEED_PAYMENT_PASSWORD），演练资金操作不用逐个设置。
   * 同时写入 preview 身份（sim{id}），H5 预览登录框输入即可登进该用户。
   */
  async registerBatch(input: { count: number; inviterUserId?: string }): Promise<{
    created: { id: string; nickname: string; invitePath: string }[];
    inviterId: string;
    inviterPath: string;
  }> {
    this.assertEnabled();
    const inviter = await this.resolveInviter(input.inviterUserId);
    const payHash = await hashPassword(SEED_PAYMENT_PASSWORD);
    const { prefix, self: inviterPath, childLayer } = inviterNaming(inviter);
    const created: { id: string; nickname: string; invitePath: string }[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const now = await this.clock.now();
      const invitePath = `${prefix}${childLetters(index)}`;
      const nickname = `L${childLayer}·${invitePath}·邀${inviterPath}`;
      const user = await this.prisma.$transaction(async (tx) => {
        const row = await tx.user.create({
          data: {
            status: 'active',
            nickname,
            avatarUrl: null,
            phone: null,
            inviteCode: null,
            member: false,
            seated: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.userIdentity.create({
          data: {
            userId: row.id,
            provider: IDENTITY_PROVIDERS.simulation,
            identifier: `sim-${row.id.toString()}`,
            unionId: null,
            createdAt: now,
          },
        });
        // 同步补一条 H5 预览身份，演练中可在 H5 预览登录框输 sim{id} 以该用户登录。
        await tx.userIdentity.create({
          data: {
            userId: row.id,
            provider: IDENTITY_PROVIDERS.preview,
            identifier: `sim${row.id.toString()}`,
            unionId: null,
            createdAt: now,
          },
        });
        await tx.userPaymentPassword.create({
          data: { userId: row.id, passwordHash: payHash, updatedAt: now },
        });
        return row;
      });
      await this.users.bindInviter(user.id, inviter.inviteCode as string);
      created.push({ id: user.id.toString(), nickname: user.nickname, invitePath });
    }
    await this.append('register', { created: created.length });
    return { created, inviterId: inviter.id.toString(), inviterPath };
  }

  /**
   * 批量购买商品。创业专区会触发入座、报单、公排与分红；会员商城走消费金→
   * 可提现→微信的真实拆分，不参与报单与市场树。两个专区都走真实下单 + 沙箱支付。
   */
  async purchaseBatch(input: {
    zone?: 'startup' | 'mall';
    userIds?: string[];
    count?: number;
    productId?: string;
    quantityMin?: number;
    quantityMax?: number;
  }): Promise<{
    zone: 'startup' | 'mall';
    product: { id: string; name: string; priceFen: number };
    results: SimulatedPurchaseResult[];
  }> {
    this.assertEnabled();
    const zone = input.zone ?? 'startup';
    const product = await this.resolveProduct(zone, input.productId);
    const min = input.quantityMin ?? 1;
    const max = input.quantityMax ?? min;
    if (max < min) {
      throw new BadRequestException('数量区间不正确');
    }
    const targets = await this.resolveTargetUsers(input);
    const results: SimulatedPurchaseResult[] = [];
    for (const target of targets) {
      results.push(await this.purchaseOne(target, zone, product.id, min, max));
    }
    await this.append('purchase', { created: results.filter((item) => item.ok).length });
    return {
      zone,
      product: { id: product.id.toString(), name: product.name, priceFen: product.priceFen },
      results,
    };
  }

  /**
   * 红包报名演示。走真实的 RedPacketService.signup：会员且红包额度未领满才报得上，
   * 报名时间就是当前仿真时刻（signedAt = clock.now()）。userIds 为空时对全部
   * 在籍会员报名（一键全报名），否则只报指定用户。
   */
  async redPacketSignup(input: { userIds?: string[] } = {}): Promise<{
    total: number;
    signed: number;
    alreadySigned: number;
    skipped: number;
    results: SimulatedRedPacketSignupResult[];
  }> {
    this.assertEnabled();
    let targets: { id: bigint; nickname: string }[];
    if (input.userIds !== undefined && input.userIds.length > 0) {
      if (input.userIds.length > MAX_BATCH_USERS) {
        throw new BadRequestException(`一次最多 ${MAX_BATCH_USERS} 人`);
      }
      const ids = input.userIds.map((value) => BigInt(value));
      const rows = await this.prisma.user.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((row) => [row.id.toString(), row]));
      const missing = input.userIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(`用户不存在：${missing.join(', ')}`);
      }
      targets = input.userIds.map((id) => {
        const row = byId.get(id)!;
        return { id: row.id, nickname: row.nickname };
      });
    } else {
      targets = await this.prisma.user.findMany({
        where: { member: true, status: 'active' },
        orderBy: { id: 'asc' },
      });
      if (targets.length === 0) {
        throw new BadRequestException('还没有会员，请先注册并下单入座');
      }
    }
    const results: SimulatedRedPacketSignupResult[] = [];
    // signup() 返回的 signedUpToday 对「刚报上」和「本来已报过」都是 true，
    // 先按当前仿真时刻查一次当天报名，才能区分两种结果。
    const now = await this.clock.now();
    const bizDate = shanghaiBizDate(now);
    for (const target of targets) {
      try {
        const existing = await this.prisma.redPacketSignup.findFirst({
          where: { userId: target.id, bizDate },
        });
        if (existing) {
          results.push({
            userId: target.id.toString(),
            nickname: target.nickname,
            outcome: 'already',
            error: null,
          });
          continue;
        }
        await this.redPackets.signup(target.id);
        results.push({
          userId: target.id.toString(),
          nickname: target.nickname,
          outcome: 'signed',
          error: null,
        });
      } catch (error) {
        results.push({
          userId: target.id.toString(),
          nickname: target.nickname,
          outcome: 'skipped',
          error:
            error instanceof ForbiddenException
              ? '不具备报名资格（需会员且红包额度未领满）'
              : error instanceof Error
                ? error.message
                : '报名失败',
        });
      }
    }
    const signed = results.filter((item) => item.outcome === 'signed').length;
    const alreadySigned = results.filter((item) => item.outcome === 'already').length;
    await this.append('red_packet_signup', {
      created: signed,
      already: alreadySigned,
      skipped: results.length - signed - alreadySigned,
    });
    return { total: results.length, signed, alreadySigned, skipped: results.length - signed - alreadySigned, results };
  }

  /** 任命角色。联合创始人走付费开通（有付款记录），工作室与运营中心走管理端指定。 */
  async enrollRole(input: {
    userId: string;
    role: 'cofounder' | 'studio' | 'ops_team';
    adminId: bigint;
  }): Promise<SimulatedRoleResult> {
    this.assertEnabled();
    const userId = BigInt(input.userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    if (!user.member) {
      throw new BadRequestException('该用户还不是会员，请先让他在创业专区下单');
    }
    try {
      if (input.role === ROLE_COFOUNDER) {
        const started = await this.cofounderPay.start(userId);
        await this.wechat.simulateSuccess(started.payNo);
        await this.append('role', { created: 1 });
        return {
          userId: input.userId,
          nickname: user.nickname,
          role: ROLE_COFOUNDER,
          ok: true,
          payNo: started.payNo,
          error: null,
        };
      }
      if (input.role === ROLE_STUDIO) {
        await this.studios.appoint(userId, input.adminId);
      } else {
        await this.opsTeam.appoint(userId, input.adminId);
      }
      await this.append('role', { created: 1 });
      return {
        userId: input.userId,
        nickname: user.nickname,
        role: input.role,
        ok: true,
        payNo: null,
        error: null,
      };
    } catch (error) {
      return {
        userId: input.userId,
        nickname: user.nickname,
        role: input.role,
        ok: false,
        payNo: null,
        error: error instanceof Error ? error.message : '任命失败',
      };
    }
  }

  async timeline(): Promise<{ events: SimulationEvent[] }> {
    this.assertEnabled();
    return { events: await this.store.list() };
  }

  /**
   * 演练用户树：邀请树与市场树的边、每个用户的展示信息（昵称/身份/三个钱包可用
   * 余额），以及节点提示用的报单数据（已入公排的序号、已支付未报单的订单）。
   * 演练库数据量小，一次全量拉取；正式环境本服务整体 403，不存在规模问题。
   */
  async usersTree(): Promise<SimulationUsersTree> {
    this.assertEnabled();
    const [users, walletRows, inviteRows, marketRows, cofounders, studios, opsTeam, filingRows] =
      await Promise.all([
        this.prisma.user.findMany({ orderBy: { id: 'asc' } }),
        this.prisma.walletAccount.findMany(),
        this.prisma.inviteTreeNode.findMany({ orderBy: { depth: 'asc' } }),
        this.prisma.marketTreeNode.findMany({ orderBy: [{ depth: 'asc' }, { id: 'asc' }] }),
        this.prisma.cofounderEnrollment.findMany({ where: { status: COFOUNDER_STATUS_ACTIVE } }),
        this.prisma.studioEnrollment.findMany({ where: { status: STUDIO_STATUS_ACTIVE } }),
        this.prisma.opsTeamEnrollment.findMany({ where: { status: OPS_TEAM_STATUS_ACTIVE } }),
        this.prisma.filing.findMany({ orderBy: { filedAt: 'asc' } }),
      ]);
    const unfiledRows = await this.prisma.startupSubOrder.findMany({
      where: { filedAt: null },
      orderBy: { paidAt: 'asc' },
    });
    const orderIds = [...new Set(unfiledRows.map((row) => row.orderId))];
    const orders = orderIds.length
      ? await this.prisma.order.findMany({ where: { id: { in: orderIds } } })
      : [];
    const orderNoById = new Map(orders.map((row) => [row.id, row.orderNo]));

    const seated = new Set(marketRows.map((row) => row.userId.toString()));
    const cofounderIds = new Set(cofounders.map((row) => row.userId.toString()));
    const studioIds = new Set(studios.map((row) => row.userId.toString()));
    const opsTeamIds = new Set(opsTeam.map((row) => row.userId.toString()));
    const walletsByUser = new Map<string, { withdrawable: number; points: number; consumption: number }>();
    for (const row of walletRows) {
      const key = row.userId.toString();
      const entry = walletsByUser.get(key) ?? { withdrawable: 0, points: 0, consumption: 0 };
      const balance = Number(row.balanceFen);
      if (row.walletType === WALLET_WITHDRAWABLE) {
        entry.withdrawable = balance;
      } else if (row.walletType === WALLET_POINTS) {
        entry.points = balance;
      } else if (row.walletType === WALLET_CONSUMPTION) {
        entry.consumption = balance;
      }
      walletsByUser.set(key, entry);
    }

    const treeUsers: SimulationTreeUser[] = users.map((row) => {
      const key = row.id.toString();
      const identities = [seated.has(key) ? 'member' : 'normal'];
      if (cofounderIds.has(key)) identities.push('cofounder');
      if (studioIds.has(key)) identities.push('studio');
      if (opsTeamIds.has(key)) identities.push('ops_team');
      return {
        userId: key,
        nickname: row.nickname,
        identities,
        wallets: walletsByUser.get(key) ?? { withdrawable: 0, points: 0, consumption: 0 },
      };
    });
    const toEdges = (rows: Array<{ userId: bigint; parentUserId: bigint | null }>): SimulationTreeEdge[] =>
      rows.map((row) => ({
        userId: row.userId.toString(),
        parentId: row.parentUserId === null ? null : row.parentUserId.toString(),
      }));

    const filings: Record<string, SimulationFilingInfo[]> = {};
    for (const row of filingRows) {
      if (row.sequence === null) {
        continue;
      }
      const key = row.userId.toString();
      const list = filings[key] ?? [];
      list.push({
        filingNo: row.filingNo,
        sequence: row.sequence,
        bizDate: row.bizDate,
        status: row.status,
        amountFen: row.amountFen,
      });
      filings[key] = list;
    }

    const unfiled: Record<string, SimulationUnfiledOrder[]> = {};
    for (const row of unfiledRows) {
      const key = row.userId.toString();
      const list = unfiled[key] ?? [];
      const orderNo = orderNoById.get(row.orderId);
      const existing = list.find((item) => item.orderNo === orderNo);
      if (existing) {
        existing.units += 1;
        existing.amountFen += row.amountFen;
      } else {
        list.push({
          orderNo: orderNo ?? row.orderId.toString(),
          paidAt: row.paidAt.toISOString(),
          units: 1,
          amountFen: row.amountFen,
        });
      }
      unfiled[key] = list;
    }

    return {
      users: treeUsers,
      invite: toEdges(inviteRows),
      market: toEdges(marketRows),
      filings,
      unfiled,
    };
  }

  /** 节点点击后的账务变动明细：三个钱包的流水按发生时间倒序合并。 */
  async userLedger(
    input: { userId: bigint; limit: number },
  ): Promise<{ entries: SimulationLedgerEntry[] }> {
    this.assertEnabled();
    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const rows = await this.prisma.walletLedgerEntry.findMany({
      where: { userId: input.userId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    });
    return {
      entries: rows.map((row) => ({
        id: row.id.toString(),
        occurredAt: row.occurredAt.toISOString(),
        walletType: row.walletType,
        direction: row.direction,
        amountFen: Number(row.amountFen),
        balanceAfterFen: Number(row.balanceAfterFen),
        bizType: row.bizType,
        bizId: row.bizId,
        sourceCode: row.sourceCode,
      })),
    };
  }

  /**
   * 只清时间轴，不动业务数据。清完就当从未仿真过：仿真时钟覆盖一并清掉，
   * 下次推进从真实时间重新起算。
   */
  async reset(): Promise<{ status: SimulationStatus }> {
    this.assertEnabled();
    await this.store.clear();
    await this.clearSimulatedClock();
    return { status: await this.status() };
  }

  /**
   * 清空业务数据，保留商品、内容、管理员与系统配置。
   * 根账户及其席位保留，否则新用户没有可挂靠的邀请人。
   * 同时把仿真时钟拉回真实时间，并清空时间轴——重置就是从零开始的一次新演练，
   * 旧事件与旧差分留在列表里只会干扰观察。
   */
  async resetData(): Promise<{
    removedUsers: number;
    status: SimulationStatus;
  }> {
    this.assertEnabled();
    const root = await this.prisma.user.findFirst({ where: { inviteCode: ROOT_INVITE_CODE } });
    if (!root) {
      throw new BadRequestException('根账户不存在，不能重置');
    }
    const removedUsers = await this.prisma.$transaction(
      async (tx) => {
        // 先清业务与账务，再清用户，避免留下找不到用户的孤儿行。
        await tx.redPacketClaim.deleteMany({});
        await tx.redPacketPayout.deleteMany({});
        await tx.redPacketRound.deleteMany({});
        await tx.redPacketSignup.deleteMany({});
        await tx.redPacketDailyAccrual.deleteMany({});
        await tx.positionDividendRecord.deleteMany({});
        await tx.positionDividendExclusion.deleteMany({});
        await tx.positionDividendPeriod.deleteMany({});
        await tx.userPosition.deleteMany({});
        await tx.cofounderPayout.deleteMany({});
        await tx.cofounderPayoutBatch.deleteMany({});
        await tx.cofounderAccrual.deleteMany({});
        await tx.cofounderActivation.deleteMany({});
        await tx.cofounderEnrollment.deleteMany({});
        await tx.cofounderScheduleSlot.deleteMany({});
        await tx.cofounderPool.deleteMany({});
        await tx.studioAccrual.deleteMany({});
        await tx.studioEnrollment.deleteMany({});
        await tx.opsTeamAccrual.deleteMany({});
        await tx.opsTeamEnrollment.deleteMany({});
        await tx.opsTeamSeat.deleteMany({});
        await tx.filingSettlement.deleteMany({});
        await tx.filing.deleteMany({});
        await tx.filingDailyCheck.deleteMany({});
        await tx.filingCounter.deleteMany({});
        await tx.startupSubOrder.deleteMany({});
        await tx.rewardLedgerEntry.deleteMany({});
        await tx.settlementCompensation.deleteMany({});
        await tx.orderRefund.deleteMany({});
        await tx.orderItem.deleteMany({});
        await tx.order.deleteMany({});
        await tx.payment.deleteMany({});
        await tx.withdrawalSettlement.deleteMany({});
        await tx.withdrawalDisplaySource.deleteMany({});
        await tx.withdrawalApplication.deleteMany({});
        await tx.walletHold.deleteMany({});
        await tx.consumptionTransfer.deleteMany({});
        await tx.walletLedgerEntry.deleteMany({});
        await tx.cashLedgerEntry.deleteMany({});
        await tx.userMessage.deleteMany({});
        await tx.userKyc.deleteMany({});
        await tx.userPaymentPassword.deleteMany({});
        await tx.userBankAccount.deleteMany({});
        await tx.walletAccount.deleteMany({ where: { userId: { not: root.id } } });
        await tx.walletAccount.updateMany({
          where: { userId: root.id },
          data: { balanceFen: 0n, frozenFen: 0n },
        });
        await tx.userAddress.deleteMany({ where: { userId: { not: root.id } } });
        await tx.userIdentity.deleteMany({ where: { userId: { not: root.id } } });
        await tx.inviteTreeNode.deleteMany({ where: { userId: { not: root.id } } });
        await tx.marketTreeOpenSlot.deleteMany({});
        await tx.marketTreeNode.deleteMany({ where: { userId: { not: root.id } } });
        // 根节点的 child_count 是历史残留（删光孩子后必须归零），否则重建空位时
        // 按 3 - child_count 算出 0 个空位，之后所有入座全部失败。
        await tx.marketTreeNode.update({
          where: { userId: root.id },
          data: { childCount: 0 },
        });
        const removed = await tx.user.deleteMany({ where: { id: { not: root.id } } });
        return removed.count;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    // 用户表自增 ID 拉回 1（表里只剩根账户，MySQL 会自动取 max(id)+1 兜底）。
    // ALTER TABLE 是 DDL，会隐式提交，不能放进上面的事务里。
    // 不重置的话，反复重置后新用户编号会一直涨，演练里看着像有历史残留。
    // 只处理 users 表，其余表的自增不回退。
    await this.prisma.$executeRawUnsafe('ALTER TABLE `users` AUTO_INCREMENT = 1');
    await this.rebuildSeatSlots();
    await this.clearSimulatedClock();
    await this.store.clear();
    this.logger.warn(`simulation business data reset, removed ${removedUsers} users`);
    return { removedUsers, status: await this.status() };
  }

  /** 清掉仿真时钟覆盖，让业务时间回到真实时间；未启用覆盖时不做任何事。 */
  private async clearSimulatedClock(): Promise<void> {
    const view = await this.clock.readOverride();
    if (view.source === 'override') {
      await this.clock.clearOverride();
    }
  }

  /** 双保险：env 开关（SIMULATION_ENABLED）关闭时一切仿真操作都拒绝。 */
  private assertEnabled(): void {
    if (!this.env.simulationEnabled) {
      throw new ForbiddenException('时间仿真台未启用（SIMULATION_ENABLED=false）');
    }
  }

  private async rebuildSeatSlots(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.marketTreeOpenSlot.deleteMany({});
      // 以真实孩子数为准重算 child_count，不信任可能漂移的缓存值；
      // 然后按 3 - 实际孩子数重建每个节点的空位行。
      await tx.$executeRaw`
        UPDATE market_tree_nodes AS node
        LEFT JOIN (
          SELECT parent_user_id, COUNT(*) AS cnt
          FROM market_tree_nodes
          WHERE parent_user_id IS NOT NULL
          GROUP BY parent_user_id
        ) AS child ON child.parent_user_id = node.user_id
        SET node.child_count = COALESCE(child.cnt, 0)
      `;
      await tx.$executeRaw`
        INSERT INTO market_tree_open_slots
          (parent_user_id, slot, parent_depth, parent_path, open_count)
        SELECT node.user_id, position.slot, node.depth, node.path, 3 - node.child_count
        FROM market_tree_nodes AS node
        JOIN (SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3) AS position
          ON position.slot > node.child_count
      `;
    });
  }

  private async resolveInviter(
    inviterUserId: string | undefined,
  ): Promise<{ id: bigint; inviteCode: string | null; nickname: string }> {
    if (inviterUserId !== undefined) {
      const inviter = await this.prisma.user.findUnique({ where: { id: BigInt(inviterUserId) } });
      if (!inviter || !inviter.member || !inviter.inviteCode) {
        throw new BadRequestException('邀请人必须是已有邀请码的会员');
      }
      return { id: inviter.id, inviteCode: inviter.inviteCode, nickname: inviter.nickname };
    }
    const root = await this.prisma.user.findFirst({ where: { inviteCode: ROOT_INVITE_CODE } });
    if (!root) {
      throw new BadRequestException('根账户不存在');
    }
    return { id: root.id, inviteCode: root.inviteCode, nickname: root.nickname };
  }

  private async resolveProduct(
    zone: 'startup' | 'mall',
    productId: string | undefined,
  ): Promise<{
    id: bigint;
    name: string;
    priceFen: number;
  }> {
    const zoneLabel = zone === 'mall' ? '会员商城' : '创业专区';
    if (productId !== undefined) {
      const product = await this.prisma.product.findFirst({
        where: { id: BigInt(productId), zone, status: 'on' },
      });
      if (!product) {
        throw new NotFoundException(`${zoneLabel}商品不存在或未上架`);
      }
      const sku = await this.prisma.productSku.findFirst({ where: { productId: product.id } });
      if (!sku) {
        throw new NotFoundException('商品缺少规格');
      }
      return { id: product.id, name: product.name, priceFen: sku.priceFen };
    }
    const product = await this.prisma.product.findFirst({
      where: { zone, status: 'on' },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    if (!product) {
      throw new BadRequestException(`${zoneLabel}没有上架商品，请先创建一件`);
    }
    const sku = await this.prisma.productSku.findFirst({ where: { productId: product.id } });
    if (!sku) {
      throw new NotFoundException('商品缺少规格');
    }
    return { id: product.id, name: product.name, priceFen: sku.priceFen };
  }

  private async resolveTargetUsers(input: {
    userIds?: string[];
    count?: number;
  }): Promise<{ id: bigint; nickname: string }[]> {
    if (input.userIds !== undefined && input.userIds.length > 0) {
      if (input.userIds.length > MAX_BATCH_USERS) {
        throw new BadRequestException(`一次最多 ${MAX_BATCH_USERS} 人`);
      }
      const ids = input.userIds.map((value) => BigInt(value));
      const rows = await this.prisma.user.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((row) => [row.id.toString(), row]));
      const missing = input.userIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(`用户不存在：${missing.join(', ')}`);
      }
      return input.userIds.map((id) => {
        const row = byId.get(id);
        return { id: row!.id, nickname: row!.nickname };
      });
    }
    const count = input.count ?? 1;
    if (count < 1 || count > MAX_BATCH_USERS) {
      throw new BadRequestException(`人数必须是 1 到 ${MAX_BATCH_USERS}`);
    }
    const pool = await this.prisma.user.findMany({
      where: { status: 'active', seated: true },
      orderBy: { id: 'asc' },
      take: MAX_BATCH_USERS * 5,
    });
    if (pool.length === 0) {
      throw new BadRequestException('还没有已入座的会员，请先注册并下单');
    }
    const shuffled = [...pool]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(count, pool.length));
    return shuffled.map((row) => ({ id: row.id, nickname: row.nickname }));
  }

  private async purchaseOne(
    target: { id: bigint; nickname: string },
    zone: 'startup' | 'mall',
    productId: bigint,
    min: number,
    max: number,
  ): Promise<SimulatedPurchaseResult> {
    const quantity = min + Math.floor(Math.random() * (max - min + 1));
    const base: SimulatedPurchaseResult = {
      userId: target.id.toString(),
      nickname: target.nickname,
      ok: false,
      orderId: null,
      orderNo: null,
      quantity,
      payAmountFen: 0,
      status: null,
      filed: false,
      error: null,
    };
    try {
      const addressId = await this.ensureAddress(target.id, target.nickname);
      const order = await this.orders.create(target.id, {
        zone,
        addressId,
        items: [{ productId, quantity }],
      });
      const paid = await this.orders.pay(target.id, order.id, {});
      if (paid.wechat) {
        await this.wechat.simulateSuccess(paid.wechat.payNo);
      }
      const fresh = await this.orders.getForUser(target.id, order.id);
      let filed = false;
      if (zone === 'startup') {
        const now = await this.clock.now();
        const filing = await this.prisma.filing.findFirst({
          where: { userId: target.id, bizDate: shanghaiBizDate(now) },
        });
        filed = filing !== null;
      }
      return {
        ...base,
        ok: true,
        orderId: fresh.id.toString(),
        orderNo: fresh.orderNo,
        payAmountFen: fresh.payAmountFen,
        status: fresh.status,
        filed,
      };
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : '下单失败',
      };
    }
  }

  private async ensureAddress(userId: bigint, nickname: string): Promise<bigint> {
    const existing = await this.prisma.userAddress.findFirst({
      where: { userId },
      orderBy: { id: 'asc' },
    });
    if (existing) {
      return existing.id;
    }
    const now = await this.clock.now();
    const created = await this.prisma.userAddress.create({
      data: {
        userId,
        contactName: nickname,
        contactPhone: '13800000000',
        province: '上海市',
        city: '上海市',
        district: '浦东新区',
        detail: '仿真实训路 1 号',
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    return created.id;
  }

  private async resolveTarget(
    currentOverride: string,
    input: { to?: string; byMinutes?: number },
  ): Promise<Date> {
    const current = this.clock.instant(Date.parse(currentOverride));
    if (input.to !== undefined) {
      const ms = Date.parse(input.to);
      if (Number.isNaN(ms)) {
        throw new BadRequestException('无效的 ISO 时间');
      }
      return this.clock.instant(ms);
    }
    const byMinutes = input.byMinutes;
    if (byMinutes !== undefined) {
      if (!Number.isInteger(byMinutes) || byMinutes <= 0 || byMinutes > 60 * 24 * 366) {
        throw new BadRequestException('byMinutes 必须是 1 到 527040 的整数');
      }
      return this.clock.instant(current.getTime() + byMinutes * 60_000);
    }
    return this.clock.now();
  }

  /** 账务快照：钱包账户余额、现金账净额、关键计数。 */
  private async snapshot(): Promise<SimulationSnapshot> {
    const accounts = await this.prisma.walletAccount.findMany();
    const sumBalance = (type: string) =>
      accounts
        .filter((row) => row.walletType === type)
        .reduce((total, row) => total + row.balanceFen, 0n);
    const sumFrozen = (type: string) =>
      accounts
        .filter((row) => row.walletType === type)
        .reduce((total, row) => total + row.frozenFen, 0n);

    const cashRows = await this.prisma.cashLedgerEntry.findMany();
    let cashIn = 0n;
    let cashOut = 0n;
    for (const row of cashRows) {
      if (row.direction === 'inflow') {
        cashIn += row.amountFen;
      } else {
        cashOut += row.amountFen;
      }
    }

    const [orders, pendingWithdrawals, pendingCompensations] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.withdrawalApplication.count({ where: { status: WITHDRAWAL_PENDING } }),
      this.prisma.settlementCompensation.count({
        where: { status: { in: [COMPENSATION_AUTO_RETRY, COMPENSATION_AWAITING_OPERATION] } },
      }),
    ]);

    return {
      wallet: {
        points: Number(sumBalance(WALLET_POINTS)),
        withdrawable: Number(sumBalance(WALLET_WITHDRAWABLE)),
        consumption: Number(sumBalance(WALLET_CONSUMPTION)),
        withdrawableFrozen: Number(sumFrozen(WALLET_WITHDRAWABLE)),
        consumptionFrozen: Number(sumFrozen(WALLET_CONSUMPTION)),
        pointsFrozen: Number(sumFrozen(WALLET_POINTS)),
      },
      cash: { inflow: Number(cashIn), outflow: Number(cashOut) },
      counts: { orders, pendingWithdrawals, pendingCompensations },
    };
  }

  private async append(
    action: SimulationEvent['action'],
    detail: SimulationEvent['detail'],
    diff: SimulationDiff | null = null,
  ): Promise<SimulationEvent> {
    eventSeq += 1;
    const now = await this.clock.now();
    const event: SimulationEvent = {
      id: `${now.getTime()}-${eventSeq}`,
      at: now.toISOString(),
      action,
      detail,
      diff,
    };
    await this.store.append(event);
    return event;
  }
}

function diffOf(before: SimulationSnapshot, after: SimulationSnapshot): SimulationDiff {
  return {
    wallet: {
      points: after.wallet.points - before.wallet.points,
      withdrawable: after.wallet.withdrawable - before.wallet.withdrawable,
      consumption: after.wallet.consumption - before.wallet.consumption,
      withdrawableFrozen: after.wallet.withdrawableFrozen - before.wallet.withdrawableFrozen,
      consumptionFrozen: after.wallet.consumptionFrozen - before.wallet.consumptionFrozen,
      pointsFrozen: after.wallet.pointsFrozen - before.wallet.pointsFrozen,
    },
    cash: {
      inflow: after.cash.inflow - before.cash.inflow,
      outflow: after.cash.outflow - before.cash.outflow,
    },
    counts: {
      orders: after.counts.orders - before.counts.orders,
      pendingWithdrawals: after.counts.pendingWithdrawals - before.counts.pendingWithdrawals,
      pendingCompensations: after.counts.pendingCompensations - before.counts.pendingCompensations,
    },
  };
}

/**
 * 批量注册的邀请谱系序号：a、b、…、z、aa、ab…（26 进制小写）。
 * 大写字母段留给市场树路径，小写段表示从邀请人延伸出来的谱系。
 */
function childLetters(index: number): string {
  let rest = index;
  let text = '';
  do {
    text = String.fromCharCode(97 + (rest % 26)) + text;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return text;
}

/**
 * 从邀请人推出批量注册的命名参数。
 * 根账户的前缀是空串（它的孩子路径直接是 a、b、c…，层 1）；
 * 其他会员从昵称里取树路径（L{层}·{路径}·… 的第二段），取不到就用邀请码。
 */
function inviterNaming(inviter: { inviteCode: string | null; nickname: string }): {
  prefix: string;
  self: string;
  childLayer: number;
} {
  if (inviter.inviteCode === ROOT_INVITE_CODE) {
    return { prefix: '', self: 'R', childLayer: 1 };
  }
  const token = TREE_NICKNAME_PATTERN.exec(inviter.nickname)?.[1] ?? inviter.inviteCode ?? '';
  return { prefix: token, self: token, childLayer: token.length + 1 };
}
