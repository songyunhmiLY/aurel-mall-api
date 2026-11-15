import { ForbiddenException } from '@nestjs/common';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/app-env';
import { DueJobRunner } from '../src/jobs/due-job.runner';
import { SimulationService } from '../src/modules/simulation/simulation.service';
import type { SimulationEvent, SimulationStore } from '../src/modules/simulation/simulation.types';
import { Stage1Db } from './support/stage1-db';
import { stage1Env } from './support/stage1-harness';

class FakeClock {
  override: Date | null = null;

  async readOverride() {
    const now = this.override ?? new Date('2026-11-14T04:00:00.000Z');
    return {
      allowed: true,
      source: this.override ? ('override' as const) : ('real' as const),
      now: now.toISOString(),
      override: this.override ? this.override.toISOString() : null,
    };
  }

  async setOverride(iso: string) {
    this.override = new Date(iso);
    return this.readOverride();
  }

  async clearOverride() {
    this.override = null;
  }

  async now(): Promise<Date> {
    return this.override ?? new Date('2026-11-14T04:00:00.000Z');
  }

  instant(unixMs: number): Date {
    return new Date(unixMs);
  }
}

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

function buildService(input: { enabled: boolean; env?: Partial<AppEnv> }) {
  const db = new Stage1Db();
  const clock = new FakeClock();
  const runDueCalls: number[] = [];
  const runner = {
    async runDue(): Promise<void> {
      runDueCalls.push(runDueCalls.length + 1);
      // 模拟一次到期 job 的账务影响：一笔现金流入 + 一笔订单。
      const now = await clock.now();
      db.cashLedgerEntry.create({
        data: {
          direction: 'inflow',
          amountFen: 100n,
          bizType: 'order_wechat',
          bizId: `sim-${runDueCalls.length}`,
          occurredAt: now,
          createdAt: now,
        },
      });
      db.order.create({
        data: {
          status: 'paid',
          placedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    },
  } as unknown as DueJobRunner;
  const env: AppEnv = stage1Env({
    simulationEnabled: input.enabled,
    ...input.env,
  });
  const store = new MemoryStore();
  const service = new SimulationService(
    clock as unknown as ClockService,
    runner,
    db as unknown as PrismaService,
    store,
    env,
  );
  return { db, clock, service, store, runDueCalls, env };
}

describe('simulation service', () => {
  it('refuses everything when SIMULATION_ENABLED is off', async () => {
    const { service } = buildService({ enabled: false });
    await expect(service.status()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.timeline()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.step({ byMinutes: 5 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reset()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires a clock override before stepping, then advances and records a diff', async () => {
    const { service } = buildService({ enabled: true });
    await expect(service.step({ byMinutes: 5 })).rejects.toThrow('请先设置仿真时钟起点');

    await service.setClock('2026-11-14T08:00:00.000Z');
    const before = await service.status();
    expect(before.clock.source).toBe('override');
    expect(before.clock.override).toBe('2026-11-14T08:00:00.000Z');

    const { event } = await service.step({ to: '2026-11-14T09:00:00.000Z' });
    expect(event.action).toBe('step');
    expect(event.detail.from).toBe('2026-11-14T08:00:00.000Z');
    expect(event.detail.to).toBe('2026-11-14T09:00:00.000Z');
    expect(event.diff).toMatchObject({
      cash: { inflow: 100, outflow: 0 },
      counts: { orders: 1 },
    });

    const timeline = await service.timeline();
    expect(timeline.events.map((row) => row.action)).toEqual(['set_clock', 'step']);
    expect((await service.status()).clock.override).toBe('2026-11-14T09:00:00.000Z');
  });

  it('advances by minutes and rejects non-forward targets', async () => {
    const { service } = buildService({ enabled: true });
    await service.setClock('2026-11-14T08:00:00.000Z');
    await service.step({ byMinutes: 90 });
    expect((await service.status()).clock.override).toBe('2026-11-14T09:30:00.000Z');

    await expect(service.step({ to: '2026-11-14T09:00:00.000Z' })).rejects.toThrow(
      '目标时刻必须晚于当前仿真时刻',
    );
    await expect(service.step({ byMinutes: 0 })).rejects.toThrow('byMinutes');
    await expect(service.step({ to: 'not-a-date' })).rejects.toThrow('无效的 ISO 时间');
  });

  it('clears the clock and resets the timeline', async () => {
    const { service } = buildService({ enabled: true });
    await service.setClock('2026-11-14T08:00:00.000Z');
    await service.step({ byMinutes: 5 });
    await service.clearClock();
    expect((await service.status()).clock.source).toBe('real');

    await expect(service.step({ byMinutes: 5 })).rejects.toThrow('请先设置仿真时钟起点');
    await service.reset();
    expect((await service.timeline()).events).toHaveLength(0);
  });
});
