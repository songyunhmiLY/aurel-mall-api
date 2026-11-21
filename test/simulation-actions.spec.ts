import { ForbiddenException } from '@nestjs/common';
import type { ClockService } from '../src/common/clock/clock.service';
import { verifyPassword } from '../src/common/auth/password-hasher';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/app-env';
import { DueJobRunner } from '../src/jobs/due-job.runner';
import { SimulationService } from '../src/modules/simulation/simulation.service';
import { COFOUNDER_SETTINGS_KEY } from '../src/modules/cofounder/cofounder.constants';
import type { SimulationEvent, SimulationStore } from '../src/modules/simulation/simulation.types';
import type { CofounderPayService } from '../src/modules/cofounder/cofounder-pay.service';
import type { CofounderEnrollmentService } from '../src/modules/cofounder/cofounder-enrollment.service';
import type { OpsTeamEnrollmentService } from '../src/modules/ops-team/ops-team-enrollment.service';
import type { StudioEnrollmentService } from '../src/modules/studio/studio-enrollment.service';
import type { MutableClock } from './support/stage1-harness';
import { buildStage4, stage4Locked } from './support/stage4-harness';

class MemoryStore implements SimulationStore {
  events: SimulationEvent[] = [];

  async append(event: SimulationEvent): Promise<void> {
    this.events.push(event);
  }

  async list(): Promise<SimulationEvent[]> {
    return [...this.events];
  }

  async clear(): Promise<void> {
    this.events = [];
  }
}

/** 给阶段测试的可变时钟补上仿真台需要的覆盖接口。 */
function withOverride(clock: MutableClock): MutableClock {
  let override: Date | null = null;
  const read = async () => ({
    allowed: true,
    source: override ? ('override' as const) : ('real' as const),
    now: clock.current.toISOString(),
    override: override ? override.toISOString() : null,
  });
  const target = clock as unknown as Record<string, unknown>;
  target.readOverride = read;
  target.setOverride = async (iso: string) => {
    override = new Date(iso);
    clock.current = new Date(iso);
    return read();
  };
  target.clearOverride = async () => {
    override = null;
  };
  target.resolve = async () => ({
    now: clock.current,
    realNow: clock.current,
    source: override ? ('override' as const) : ('real' as const),
  });
  return clock;
}

function buildSimulation(enabled: boolean, overrides: Partial<AppEnv> = {}) {
  const stage = buildStage4();
  const clock = withOverride(stage.clock);
  const runnerCalls: string[] = [];
  const runner = {
    async runDue(): Promise<void> {
      runnerCalls.push((await clock.now()).toISOString());
    },
  } as unknown as DueJobRunner;
  const env: AppEnv = {
    ...stage.env,
    ...overrides,
    simulationEnabled: enabled,
    allowClockOverride: true,
  };
  const service = new SimulationService(
    clock as unknown as ClockService,
    runner,
    stage.db as unknown as PrismaService,
    stage.users,
    stage.orders,
    stage.wechatPay,
    {} as unknown as CofounderPayService,
    stage.cofounderSettings,
    {} as unknown as CofounderEnrollmentService,
    {} as unknown as StudioEnrollmentService,
    {} as unknown as OpsTeamEnrollmentService,
    new MemoryStore(),
    env,
  );
  return { stage, clock, runnerCalls, service };
}

describe('simulation actions', () => {
  it('refuses the new actions when SIMULATION_ENABLED is off', async () => {
    const { service } = buildSimulation(false);
    await expect(service.overview()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.registerBatch({ count: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.purchaseBatch({ count: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.advance({ to: '2026-01-02T00:00:00.000Z' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.resetData()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('clears the simulated clock when the timeline is reset', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    await service.setClock('2026-01-10T00:00:00.000Z');

    const result = await service.reset();

    expect(result.status.clock.source).toBe('real');
    expect(result.status.clock.override).toBeNull();
    const status = await service.status();
    expect(status.clock.override).toBeNull();
  });

  it('registers a batch under the root inviter with rule-based nicknames and payment passwords', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const rootId = stage.db.user.rows.find((row) => row.inviteCode === '000000')!.id;
    const before = stage.db.user.rows.length;

    const created = await service.registerBatch({ count: 3 });

    expect(created.inviterId).toBe(rootId.toString());
    expect(created.inviterPath).toBe('R');
    expect(created.created.map((item) => item.nickname)).toEqual([
      'L1·a·邀R',
      'L1·b·邀R',
      'L1·c·邀R',
    ]);
    expect(stage.db.user.rows).toHaveLength(before + 3);
    const invites = stage.db.inviteTreeNode.rows.filter((row) => row.parentUserId === rootId);
    expect(invites).toHaveLength(3);
    const simulationIdentities = stage.db.userIdentity.rows.filter(
      (row) => row.provider === 'simulation',
    );
    expect(simulationIdentities).toHaveLength(3);
    const paymentRows = stage.db.userPaymentPassword.rows;
    expect(paymentRows).toHaveLength(3);
    const hashed = paymentRows[0]!.passwordHash as string;
    expect(await verifyPassword(hashed, '123456')).toBe(true);
  });

  it('names batch registrations after the inviter tree path', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const product = await stage.catalog.create({
      zone: 'startup',
      name: '创业礼包',
      freightFen: 0,
      stockQuantity: 999,
      status: 'on',
    });

    // 邀请人必须是会员：先注册并购买入座，再改成带树路径的昵称（L2·BA = B 下左位）。
    const first = await service.registerBatch({ count: 1 });
    await service.purchaseBatch({
      userIds: [first.created[0]!.id],
      productId: product.product.id.toString(),
    });
    const inviterId = BigInt(first.created[0]!.id);
    await stage.db.user.update({
      where: { id: inviterId },
      data: { nickname: 'L2·BA·父B·邀R' },
    });

    const created = await service.registerBatch({ count: 2, inviterUserId: inviterId.toString() });

    expect(created.inviterPath).toBe('BA');
    expect(created.created.map((item) => item.nickname)).toEqual(['L3·BAa·邀BA', 'L3·BAb·邀BA']);
    expect(
      stage.db.inviteTreeNode.rows.filter((row) => row.parentUserId === inviterId),
    ).toHaveLength(2);
  });

  it('buys for selected users: real orders, seats, and filing', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const product = await stage.catalog.create({
      zone: 'startup',
      name: '创业礼包',
      freightFen: 0,
      stockQuantity: 100,
      status: 'on',
    });
    const created = await service.registerBatch({ count: 2 });
    const userIds = created.created.map((item) => item.id);

    const result = await service.purchaseBatch({
      userIds,
      productId: product.product.id.toString(),
      quantityMin: 2,
      quantityMax: 2,
    });

    expect(result.results).toHaveLength(2);
    const unit = stage.locked.startupZoneUnitPriceFen;
    for (const item of result.results) {
      expect(item.ok).toBe(true);
      expect(item.quantity).toBe(2);
      expect(item.status).toBe('paid');
      expect(item.payAmountFen).toBe(unit * 2);
      expect(item.filed).toBe(true);
    }
    expect(stage.db.order.rows).toHaveLength(2);
    const payments = stage.db.payment.rows.filter((row) => row.status === 'success');
    expect(payments).toHaveLength(2);
    expect(stage.db.marketTreeNode.rows).toHaveLength(3);
    const members = stage.db.user.rows.filter((row) => row.member === true);
    expect(members).toHaveLength(3);
    expect(stage.db.startupSubOrder.rows).toHaveLength(4);
    expect(stage.db.filing.rows).toHaveLength(2);
    expect(stage.db.userAddress.rows).toHaveLength(2);
  });

  it('buys mall products for selected members without seating or filing', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const startup = await stage.catalog.create({
      zone: 'startup',
      name: '创业礼包',
      freightFen: 0,
      stockQuantity: 999,
      status: 'on',
    });
    const category = await stage.catalog.createCategory({ name: '日用品' });
    const mall = await stage.catalog.create({
      zone: 'mall',
      name: '商城好物',
      freightFen: 0,
      stockQuantity: 999,
      status: 'on',
      priceFen: 5000,
      pvFen: 5000,
      categoryId: category.id,
    });
    // 先买创业专区入座成为会员，商城下单要求会员身份。
    const created = await service.registerBatch({ count: 2 });
    const userIds = created.created.map((item) => item.id);
    await service.purchaseBatch({ userIds, productId: startup.product.id.toString() });
    const filingsBefore = stage.db.filing.rows.length;
    const treeBefore = stage.db.marketTreeNode.rows.length;

    const result = await service.purchaseBatch({
      zone: 'mall',
      userIds,
      productId: mall.product.id.toString(),
      quantityMin: 1,
      quantityMax: 1,
    });

    expect(result.zone).toBe('mall');
    expect(result.results).toHaveLength(2);
    for (const item of result.results) {
      expect(item.ok).toBe(true);
      expect(item.status).toBe('paid');
      expect(item.payAmountFen).toBe(5000);
      // 商城单不报单、不新增市场树席位。
      expect(item.filed).toBe(false);
    }
    expect(stage.db.filing.rows).toHaveLength(filingsBefore);
    expect(stage.db.marketTreeNode.rows).toHaveLength(treeBefore);
    expect(stage.db.order.rows.filter((row) => row.zone === 'mall')).toHaveLength(2);
    // 商城单不产生创业子单。
    expect(stage.db.startupSubOrder.rows).toHaveLength(2);
  });

  it('rejects mall orders for non-members and wrong-zone products', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const startup = await stage.catalog.create({
      zone: 'startup',
      name: '创业礼包',
      freightFen: 0,
      stockQuantity: 999,
      status: 'on',
    });
    const category = await stage.catalog.createCategory({ name: '日用品' });
    const mall = await stage.catalog.create({
      zone: 'mall',
      name: '商城好物',
      freightFen: 0,
      stockQuantity: 999,
      status: 'on',
      priceFen: 5000,
      pvFen: 5000,
      categoryId: category.id,
    });
    const created = await service.registerBatch({ count: 1 });
    const plainUserId = created.created[0]!.id;

    // 未入座的普通用户不能下商城单，逐单返回失败原因而不是整批报错。
    const blocked = await service.purchaseBatch({
      zone: 'mall',
      userIds: [plainUserId],
      productId: mall.product.id.toString(),
    });
    expect(blocked.results[0]!.ok).toBe(false);
    expect(blocked.results[0]!.error).toContain('只有会员');

    // 用创业商品编号买商城会被拒绝。
    await expect(
      service.purchaseBatch({
        zone: 'mall',
        userIds: [plainUserId],
        productId: startup.product.id.toString(),
      }),
    ).rejects.toThrow('会员商城商品不存在或未上架');
  });

  it('seeds a full 3-9-27 tree with rule-based nicknames', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const product = await stage.catalog.create({
      zone: 'startup',
      name: '创业礼包',
      freightFen: 0,
      stockQuantity: 999,
      status: 'on',
    });
    const usersBefore = stage.db.user.rows.length;

    const result = await service.seedTree({
      productId: product.product.id.toString(),
      reset: false,
    });

    expect(result.layers).toEqual([3, 9, 27]);
    expect(result.created).toHaveLength(39);
    expect(result.created.every((item) => item.ok)).toBe(true);
    expect(stage.db.user.rows).toHaveLength(usersBefore + 39);

    // 每层节点数与层级命名。
    for (const layer of [1, 2, 3]) {
      const nodes = result.created.filter((item) => item.layer === layer);
      expect(nodes).toHaveLength(3 ** layer);
    }
    expect(result.created.find((item) => item.treePath === 'A')?.nickname).toBe('L1·A·父R·邀R');
    expect(result.created.find((item) => item.treePath === 'BA')?.nickname).toBe('L2·BA·父B·邀R');
    expect(result.created.find((item) => item.treePath === 'ABC')?.nickname).toBe(
      'L3·ABC·父AB·邀R',
    );

    // 树结构：每个非根节点的父路径 = 自己路径去掉最后一位；根恰好 3 个孩子。
    const byId = new Map(stage.db.marketTreeNode.rows.map((row) => [row.userId, row]));
    expect(byId.size).toBe(40);
    for (const item of result.created) {
      const node = byId.get(BigInt(item.userId))!;
      expect(node.depth).toBe(item.layer);
    }
    const rootId = stage.db.user.rows.find((row) => row.inviteCode === '000000')!.id;
    const rootChildren = [...byId.values()].filter((row) => row.parentUserId === rootId);
    expect(rootChildren).toHaveLength(3);

    // 邀请关系全部指向根账户：邀请 ≠ 树上级（除第一层）。
    for (const item of result.created.filter((node) => node.layer > 1)) {
      expect(item.invitedBy).toBe('R');
      expect(item.parentPath).not.toBe('R');
    }

    // 支付密码统一 123456。
    const paymentRows = stage.db.userPaymentPassword.rows;
    expect(paymentRows).toHaveLength(39);
    expect(await verifyPassword(paymentRows[0]!.passwordHash as string, '123456')).toBe(true);
  });

  it('refuses to seed more nodes than the cap and validates layer sizes', async () => {
    const { service } = buildSimulation(true);
    await expect(service.seedTree({ layers: [27, 27, 27, 27], reset: false })).rejects.toThrow(
      '单次最多生成',
    );
    await expect(service.seedTree({ layers: [0], reset: false })).rejects.toThrow('每层节点数');
    await expect(service.seedTree({ layers: [1, 2, 3, 4, 5], reset: false })).rejects.toThrow(
      '层数',
    );
  });

  it('advances day by day at configured clock times, ending at the target', async () => {
    const { stage, service, runnerCalls } = buildSimulation(true);
    await stage.users.onModuleInit();
    await service.setClock('2026-01-02T05:00:00.000Z');

    const advanced = await service.advance({ to: '2026-01-04T05:00:00.000Z' });

    // 档位 = 报单钟点 00:01 + 日末 23:59（联创默认即时发放，无额外档位）。
    // 1/2 23:59；1/3 00:01、23:59；1/4 00:01；加目标时刻兜底，共 5 次。
    // 任务的真实执行耗时（stub 为毫秒级）加到仿真时钟上，但远小于档位间隔，
    // 不会把下一档顺延。
    expect(advanced.steps).toBe(5);
    expect(runnerCalls).toHaveLength(advanced.steps);
    const sorted = [...runnerCalls].sort();
    expect(runnerCalls).toEqual(sorted);
    expect(runnerCalls[0]).toBe('2026-01-02T15:59:00.000Z');
    expect(runnerCalls[1]).toBe('2026-01-02T16:01:00.000Z');
    expect(runnerCalls[runnerCalls.length - 1]).toBe('2026-01-04T05:00:00.000Z');
    const status = await service.status();
    expect(status.clock.override).toBe('2026-01-04T05:00:00.000Z');
  });

  it('runs daily jobs at the configured clock time, not hardcoded slots', async () => {
    const { stage, service, runnerCalls } = buildSimulation(true, {
      locked: { ...stage4Locked(), filingDailyCheckTime: '02:30' },
    });
    await stage.users.onModuleInit();
    await service.setClock('2026-01-02T05:00:00.000Z');

    await service.advance({ to: '2026-01-03T05:00:00.000Z' });

    // 报单钟点改成 02:30 后，档位就在 02:30（上海）执行；任务耗时只体现在档位后的时钟上。
    expect(runnerCalls).toEqual([
      '2026-01-02T15:59:00.000Z',
      '2026-01-02T18:30:00.000Z',
      '2026-01-03T05:00:00.000Z',
    ]);
  });

  it('adds the cofounder payout clock as a daily slot', async () => {
    const { stage, service, runnerCalls } = buildSimulation(true);
    await stage.users.onModuleInit();
    // 直接写联创配置行：每日 10:00 定期发放。
    await stage.db.adminSetting.create({
      data: {
        settingKey: COFOUNDER_SETTINGS_KEY,
        settingValue: JSON.stringify({
          seatCap: 100,
          userButtonOpen: false,
          activationAmountFen: '0',
          payoutMode: 'periodic',
          schedule: {
            cycle: 'daily',
            time: '10:00',
            weekday: 1,
            monthDay: 1,
            intervalDays: 1,
            anchorDate: '2026-01-01',
          },
          poolThresholdFen: '0',
          perPersonThresholdFen: '0',
        }),
        updatedAt: new Date(),
        updatedByAdminId: 1n,
      },
    });
    await service.setClock('2026-01-02T05:00:00.000Z');

    await service.advance({ to: '2026-01-03T05:00:00.000Z' });

    // 联创每日 10:00（上海）= 02:00Z 成为一个档位；任务耗时毫秒级，不改变后续档位时刻。
    expect(runnerCalls).toEqual([
      '2026-01-02T15:59:00.000Z',
      '2026-01-02T16:01:00.000Z',
      '2026-01-03T02:00:00.000Z',
      '2026-01-03T05:00:00.000Z',
    ]);
  });

  it('rejects backward time and requires a clock start', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    await expect(service.advance({ to: '2026-02-01T00:00:00.000Z' })).rejects.toThrow(
      '请先设置仿真时钟起点',
    );
    await service.setClock('2026-01-10T00:00:00.000Z');
    await expect(service.advance({ to: '2026-01-09T00:00:00.000Z' })).rejects.toThrow(
      '目标时刻必须晚于当前仿真时刻',
    );
    await expect(service.advance({ to: '2027-01-10T00:00:00.000Z' })).rejects.toThrow(
      '单次最多推进',
    );
  });
});
