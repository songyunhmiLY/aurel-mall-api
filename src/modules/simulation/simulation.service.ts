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
import {
  SIMULATION_STORE,
  type SimulationDiff,
  type SimulationEvent,
  type SimulationOverview,
  type SimulationSnapshot,
  type SimulationStatus,
  type SimulationStore,
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

/** 市场树位次字母：槽位 1/2/3 = 左/中/右 = A/B/C。 */
const SLOT_LETTERS = ['A', 'B', 'C'] as const;

/** 演练命名规则：L{层}·{路径}·父{父路径}·邀{邀请人路径}，第二段是树路径。 */
const TREE_NICKNAME_PATTERN = /^L\d+·([A-Za-z]+)·/;

/** 单次生成演示树的节点上限。 */
const MAX_SEED_NODES = 100;
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

/**
 * 时间仿真台。
 * 1. 时钟：设置/清除覆盖，单步推进，逐业务日推进；
 * 2. 造数：批量注册、批量购买创业专区、任命角色；
 * 3. 观测：总览、时间轴、每步账务差分；
 * 4. 重置：清空业务数据，保留商品与系统配置。
 *
 * 只在非正式环境启用：env.simulationEnabled=false 时所有操作都拒绝。
 * 造数走的是正式业务服务（下单、支付、报单、入座、角色开通），不是伪造行。
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
    const [total, members, orderCount, paid, cofounders, studios, opsTeam] = await Promise.all([
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
    ]);
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
   * 逐业务日推进。从当前仿真时刻到目标时刻，每天在各任务的计划钟点各跑一次到期任务：
   * 报单检查与红包结算用 env 配置的每日报单钟点，联合创始人定期分配用管理端配置的
   * 钟点，按业务日判定的任务在 23:59 兜底——钟点与真实环境一致，任务记录的时间戳
   * 就是它的计划时刻。每次档位执行完后，仿真时钟前进「模拟任务耗时」（见
   * SIMULATION_TASK_DURATION_MINUTES），体现真实环境里任务占用的时间；若耗时压到了
   * 下一档位，下一档顺延执行。终点兜底一次（若目标时刻落在任务耗时区间内，时钟会
   * 停在任务结束后）。只能往后推进。
   */
  async advance(input: { to: string }): Promise<{
    status: SimulationStatus;
    event: SimulationEvent;
    steps: number;
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

    const durationMs = this.env.simulationTaskDurationMinutes * 60_000;
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
        await this.runner.runDue();
        steps += 1;
        lastEnd = Math.max(lastEnd, instant.getTime() + durationMs);
      }
      cursor = addShanghaiDays(cursor, 1);
    }
    // 目标时刻本身再跑一次，覆盖落在非整点的定时策略。
    const finalAt = Math.max(target.getTime(), lastEnd);
    await this.clock.setOverride(this.clock.instant(finalAt).toISOString());
    await this.runner.runDue();
    steps += 1;

    const diff = diffOf(before, await this.snapshot());
    const event = await this.append(
      'advance',
      { from: view.override, to: this.clock.instant(finalAt).toISOString(), steps },
      diff,
    );
    this.logger.log(
      `simulation advanced ${view.override} -> ${this.clock.instant(finalAt).toISOString()} (${steps} steps)`,
    );
    return { status: await this.status(), event, steps };
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
   * 批量注册。用户是真实 users 行，挂了邀请关系，能直接下单。
   * 邀请人必须是已有会员（默认根账户）：只有会员才有邀请码。
   */
  /**
   * 批量注册仿真用户，昵称按演练命名规则生成：
   * `L{层}·{邀请路径}{序号}·邀{邀请人路径}`，序号是 26 进制小写 a、b、…、z、aa…。
   * 路径大写字母段是种子市场树（A/B/C = 左/中/右），小写段是这里延伸出的邀请谱系。
   * 每个用户都带上统一支付密码（SEED_PAYMENT_PASSWORD），演练资金操作不用逐个设置。
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
   * 生成演示市场树，默认 3+9+27 三层满树。
   *
   * 全部挂在根账户下：入座规则是「落在邀请人子树的最浅空位」，根满之后自动
   * 逐层往深处落座，所以树形必然是层序满树；而邀请人全部是根——正好演示
   * 「邀请关系 ≠ 树上级」。
   *
   * 落座后按实际席位回填昵称：`L{层}·{路径}·父{父路径}·邀R`。
   * 路径字母 A/B/C = 左/中/右，根 = R，层级 = 路径长度。
   * 每人统一支付密码 SEED_PAYMENT_PASSWORD，走真实下单、支付、报单与入座。
   */
  async seedTree(input: { layers?: number[]; reset?: boolean; productId?: string }): Promise<{
    reset: boolean;
    layers: number[];
    product: { id: string; name: string };
    created: SeededTreeNode[];
  }> {
    this.assertEnabled();
    const layers = input.layers ?? [3, 9, 27];
    if (layers.length < 1 || layers.length > 4) {
      throw new BadRequestException('层数必须是 1 到 4');
    }
    for (const count of layers) {
      if (!Number.isInteger(count) || count < 1 || count > 27) {
        throw new BadRequestException('每层节点数必须是 1 到 27');
      }
    }
    const total = layers.reduce((sum, count) => sum + count, 0);
    if (total > MAX_SEED_NODES) {
      throw new BadRequestException(`单次最多生成 ${MAX_SEED_NODES} 个节点`);
    }
    let didReset = false;
    if (input.reset ?? true) {
      await this.resetData();
      didReset = true;
    }
    const root = await this.resolveInviter(undefined);
    const product = await this.resolveProduct('startup', input.productId);
    const payHash = await hashPassword(SEED_PAYMENT_PASSWORD);
    const lettersByUserId = new Map<string, string>([[root.id.toString(), 'R']]);
    const created: SeededTreeNode[] = [];
    let order = 0;
    for (const layerCount of layers) {
      for (let index = 0; index < layerCount; index += 1) {
        order += 1;
        const provisional = `种子${String(order).padStart(3, '0')}`;
        const now = await this.clock.now();
        const user = await this.prisma.$transaction(async (tx) => {
          const row = await tx.user.create({
            data: {
              status: 'active',
              nickname: provisional,
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
          await tx.userPaymentPassword.create({
            data: { userId: row.id, passwordHash: payHash, updatedAt: now },
          });
          return row;
        });
        await this.users.bindInviter(user.id, root.inviteCode as string);
        const bought = await this.purchaseOne(
          { id: user.id, nickname: provisional },
          'startup',
          product.id,
          1,
          1,
        );
        const node = await this.prisma.marketTreeNode.findUnique({ where: { userId: user.id } });
        if (
          !node ||
          !bought.ok ||
          node.parentUserId === null ||
          node.slot === null ||
          node.depth === null
        ) {
          created.push({
            userId: user.id.toString(),
            nickname: provisional,
            treePath: '',
            parentPath: '',
            slot: 0,
            layer: 0,
            invitedBy: 'R',
            orderNo: bought.orderNo,
            ok: false,
          });
          continue;
        }
        const parentLetters = lettersByUserId.get(node.parentUserId.toString()) ?? 'R';
        const slotLetter = SLOT_LETTERS[node.slot - 1] ?? '?';
        const treePath = parentLetters === 'R' ? slotLetter : `${parentLetters}${slotLetter}`;
        lettersByUserId.set(user.id.toString(), treePath);
        const layer = node.depth;
        const parentPath = parentLetters;
        const nickname = `L${layer}·${treePath}·父${parentPath}·邀R`;
        const updated = await this.prisma.user.update({
          where: { id: user.id },
          data: { nickname },
        });
        await this.prisma.userAddress.updateMany({
          where: { userId: user.id, contactName: provisional },
          data: { contactName: nickname },
        });
        created.push({
          userId: user.id.toString(),
          nickname: updated.nickname,
          treePath,
          parentPath,
          slot: node.slot,
          layer,
          invitedBy: 'R',
          orderNo: bought.orderNo,
          ok: true,
        });
      }
    }
    await this.append('seed_tree', { created: created.filter((item) => item.ok).length });
    return {
      reset: didReset,
      layers,
      product: { id: product.id.toString(), name: product.name },
      created,
    };
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

  /** 只清时间轴，不动业务数据。 */
  async reset(): Promise<{ status: SimulationStatus }> {
    this.assertEnabled();
    await this.store.clear();
    return { status: await this.status() };
  }

  /**
   * 清空业务数据，保留商品、内容、管理员与系统配置。
   * 根账户及其席位保留，否则新用户没有可挂靠的邀请人。
   */
  async resetData(): Promise<{ removedUsers: number }> {
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
    await this.rebuildSeatSlots();
    await this.append('reset_data', { created: removedUsers });
    this.logger.warn(`simulation business data reset, removed ${removedUsers} users`);
    return { removedUsers };
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

/** seedTree 返回的每个节点：按实际席位回填的树路径与昵称。 */
export interface SeededTreeNode {
  userId: string;
  nickname: string;
  /** 市场树路径（A/B/C=左/中/右）。空串表示没入座。 */
  treePath: string;
  parentPath: string;
  slot: number;
  layer: number;
  invitedBy: string;
  orderNo: string | null;
  ok: boolean;
}

/**
 * 批量注册的邀请谱系序号：a、b、…、z、aa、ab…（26 进制小写）。
 * 大写字母段留给种子市场树路径，小写段表示从邀请人延伸出来的谱系。
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
