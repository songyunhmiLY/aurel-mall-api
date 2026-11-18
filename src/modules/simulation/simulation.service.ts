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
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { DueJobRunner } from '../../jobs/due-job.runner';
import { IDENTITY_PROVIDERS } from '../users/identity.constants';
import { UsersService } from '../users/users.service';
import { ROOT_INVITE_CODE } from '../users/identity.constants';
import { CofounderPayService } from '../cofounder/cofounder-pay.service';
import { CofounderEnrollmentService } from '../cofounder/cofounder-enrollment.service';
import { COFOUNDER_STATUS_ACTIVE } from '../cofounder/cofounder.constants';
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

/**
 * 一天里各跑一次到期任务的时点。
 * 业务定时点（报单检查、红包结算、联合创始人分配、职位发放）都落在日内，
 * 每天跑这几档就能按业务日逐格补齐，不会把多天的分红挤到最后一次算。
 */
const ADVANCE_SLOTS: { hour: number; minute: number }[] = [
  { hour: 0, minute: 1 },
  { hour: 12, minute: 0 },
  { hour: 23, minute: 59 },
];

const MAX_ADVANCE_DAYS = 180;
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
   * 逐业务日推进。从当前仿真时刻到目标时刻，每天按 ADVANCE_SLOTS 各跑一次到期任务：
   * 跨日自动报单/公排、跨月核算与分红发放都按各自的业务日执行，而不是被最后一次推进一次性补算。
   * 只能往后推进。
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

    const before = await this.snapshot();
    let steps = 0;
    let cursor = startOfShanghaiDay(from);
    const lastDay = startOfShanghaiDay(target).getTime();
    while (cursor.getTime() <= lastDay) {
      const bizDate = shanghaiBizDate(cursor);
      for (const slot of ADVANCE_SLOTS) {
        const instant = shanghaiAt(bizDate, slot.hour, slot.minute);
        if (instant.getTime() <= from.getTime() || instant.getTime() > target.getTime()) {
          continue;
        }
        await this.clock.setOverride(instant.toISOString());
        await this.runner.runDue();
        steps += 1;
      }
      cursor = addShanghaiDays(cursor, 1);
    }
    // 目标时刻本身再跑一次，覆盖落在非整点的定时策略。
    await this.clock.setOverride(target.toISOString());
    await this.runner.runDue();
    steps += 1;

    const diff = diffOf(before, await this.snapshot());
    const event = await this.append(
      'advance',
      { from: view.override, to: target.toISOString(), steps },
      diff,
    );
    this.logger.log(`simulation advanced ${view.override} -> ${target.toISOString()} (${steps} steps)`);
    return { status: await this.status(), event, steps };
  }

  /**
   * 批量注册。用户是真实 users 行，挂了邀请关系，能直接下单。
   * 邀请人必须是已有会员（默认根账户）：只有会员才有邀请码。
   */
  async registerBatch(input: {
    count: number;
    nicknamePrefix?: string;
    inviterUserId?: string;
  }): Promise<{ created: { id: string; nickname: string }[]; inviterId: string }> {
    this.assertEnabled();
    const inviter = await this.resolveInviter(input.inviterUserId);
    const prefix = (input.nicknamePrefix ?? '仿真用户').trim() || '仿真用户';
    const created: { id: string; nickname: string }[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const now = await this.clock.now();
      const nickname = `${prefix}${String(created.length + 1).padStart(3, '0')}`;
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
        return row;
      });
      await this.users.bindInviter(user.id, inviter.inviteCode as string);
      created.push({ id: user.id.toString(), nickname: user.nickname });
    }
    await this.append('register', { created: created.length });
    return { created, inviterId: inviter.id.toString() };
  }

  /**
   * 批量购买创业专区商品。走真实下单、真实支付拆分与沙箱支付成功，
   * 因此会触发入座、报单、公排与分红，和线上下单完全同一条路径。
   */
  async purchaseBatch(input: {
    userIds?: string[];
    count?: number;
    productId?: string;
    quantityMin?: number;
    quantityMax?: number;
  }): Promise<{ product: { id: string; name: string; priceFen: number }; results: SimulatedPurchaseResult[] }> {
    this.assertEnabled();
    const product = await this.resolveStartupProduct(input.productId);
    const min = input.quantityMin ?? 1;
    const max = input.quantityMax ?? min;
    if (max < min) {
      throw new BadRequestException('数量区间不正确');
    }
    const targets = await this.resolveTargetUsers(input);
    const results: SimulatedPurchaseResult[] = [];
    for (const target of targets) {
      results.push(await this.purchaseOne(target, product.id, min, max));
    }
    await this.append('purchase', { created: results.filter((item) => item.ok).length });
    return {
      product: { id: product.id.toString(), name: product.name, priceFen: product.priceFen },
      results,
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
  ): Promise<{ id: bigint; inviteCode: string | null }> {
    if (inviterUserId !== undefined) {
      const inviter = await this.prisma.user.findUnique({ where: { id: BigInt(inviterUserId) } });
      if (!inviter || !inviter.member || !inviter.inviteCode) {
        throw new BadRequestException('邀请人必须是已有邀请码的会员');
      }
      return { id: inviter.id, inviteCode: inviter.inviteCode };
    }
    const root = await this.prisma.user.findFirst({ where: { inviteCode: ROOT_INVITE_CODE } });
    if (!root) {
      throw new BadRequestException('根账户不存在');
    }
    return { id: root.id, inviteCode: root.inviteCode };
  }

  private async resolveStartupProduct(productId: string | undefined): Promise<{
    id: bigint;
    name: string;
    priceFen: number;
  }> {
    if (productId !== undefined) {
      const product = await this.prisma.product.findFirst({
        where: { id: BigInt(productId), zone: 'startup', status: 'on' },
      });
      if (!product) {
        throw new NotFoundException('创业专区商品不存在或未上架');
      }
      const sku = await this.prisma.productSku.findFirst({ where: { productId: product.id } });
      if (!sku) {
        throw new NotFoundException('商品缺少规格');
      }
      return { id: product.id, name: product.name, priceFen: sku.priceFen };
    }
    const product = await this.prisma.product.findFirst({
      where: { zone: 'startup', status: 'on' },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    if (!product) {
      throw new BadRequestException('创业专区没有上架商品，请先创建一件');
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
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(count, pool.length));
    return shuffled.map((row) => ({ id: row.id, nickname: row.nickname }));
  }

  private async purchaseOne(
    target: { id: bigint; nickname: string },
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
        zone: 'startup',
        addressId,
        items: [{ productId, quantity }],
      });
      const paid = await this.orders.pay(target.id, order.id, {});
      if (paid.wechat) {
        await this.wechat.simulateSuccess(paid.wechat.payNo);
      }
      const fresh = await this.orders.getForUser(target.id, order.id);
      const now = await this.clock.now();
      const filed = await this.prisma.filing.findFirst({
        where: { userId: target.id, bizDate: shanghaiBizDate(now) },
      });
      return {
        ...base,
        ok: true,
        orderId: fresh.id.toString(),
        orderNo: fresh.orderNo,
        payAmountFen: fresh.payAmountFen,
        status: fresh.status,
        filed: filed !== null,
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
