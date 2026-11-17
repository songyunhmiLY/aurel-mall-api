import { ForbiddenException } from '@nestjs/common';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/app-env';
import { DueJobRunner } from '../src/jobs/due-job.runner';
import { SimulationService } from '../src/modules/simulation/simulation.service';
import type { SimulationEvent, SimulationStore } from '../src/modules/simulation/simulation.types';
import type { CofounderPayService } from '../src/modules/cofounder/cofounder-pay.service';
import type { CofounderEnrollmentService } from '../src/modules/cofounder/cofounder-enrollment.service';
import type { OpsTeamEnrollmentService } from '../src/modules/ops-team/ops-team-enrollment.service';
import type { StudioEnrollmentService } from '../src/modules/studio/studio-enrollment.service';
import type { MutableClock } from './support/stage1-harness';
import { buildStage4 } from './support/stage4-harness';

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

function buildSimulation(enabled: boolean) {
  const stage = buildStage4();
  const clock = withOverride(stage.clock);
  const runnerCalls: string[] = [];
  const runner = {
    async runDue(): Promise<void> {
      runnerCalls.push((await clock.now()).toISOString());
    },
  } as unknown as DueJobRunner;
  const env: AppEnv = { ...stage.env, simulationEnabled: enabled, allowClockOverride: true };
  const service = new SimulationService(
    clock as unknown as ClockService,
    runner,
    stage.db as unknown as PrismaService,
    stage.users,
    stage.orders,
    stage.wechatPay,
    {} as unknown as CofounderPayService,
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

  it('registers a batch under the root inviter', async () => {
    const { stage, service } = buildSimulation(true);
    await stage.users.onModuleInit();
    const rootId = stage.db.user.rows.find((row) => row.inviteCode === '000000')!.id;
    const before = stage.db.user.rows.length;

    const created = await service.registerBatch({ count: 3, nicknamePrefix: '演练' });

    expect(created.created).toHaveLength(3);
    expect(created.inviterId).toBe(rootId.toString());
    expect(stage.db.user.rows).toHaveLength(before + 3);
    const nicknames = stage.db.user.rows.map((row) => row.nickname as string);
    expect(nicknames).toEqual(expect.arrayContaining(['演练001', '演练002', '演练003']));
    const invites = stage.db.inviteTreeNode.rows.filter(
      (row) => row.parentUserId === rootId,
    );
    expect(invites).toHaveLength(3);
    const freshest = stage.db.user.rows.find((row) => row.nickname === '演练001');
    expect(freshest?.member).toBe(false);
    const simulationIdentities = stage.db.userIdentity.rows.filter(
      (row) => row.provider === 'simulation',
    );
    expect(simulationIdentities).toHaveLength(3);
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

  it('advances day by day and runs jobs at every business slot', async () => {
    const { stage, service, runnerCalls } = buildSimulation(true);
    await stage.users.onModuleInit();
    await service.setClock('2026-01-02T05:00:00.000Z');

    const advanced = await service.advance({ to: '2026-01-04T05:00:00.000Z' });

    // 1/2 23:59、1/3 三个时点、1/4 00:01 与 12:00，加上目标时刻本身。
    expect(advanced.steps).toBeGreaterThanOrEqual(6);
    expect(runnerCalls).toHaveLength(advanced.steps);
    const sorted = [...runnerCalls].sort();
    expect(runnerCalls).toEqual(sorted);
    expect(runnerCalls[0]).toBe('2026-01-02T15:59:00.000Z');
    expect(runnerCalls[runnerCalls.length - 1]).toBe('2026-01-04T05:00:00.000Z');
    const status = await service.status();
    expect(status.clock.override).toBe('2026-01-04T05:00:00.000Z');
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
