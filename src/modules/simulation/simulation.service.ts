import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { DueJobRunner } from '../../jobs/due-job.runner';
import {
  COMPENSATION_AUTO_RETRY,
  COMPENSATION_AWAITING_OPERATION,
} from '../orders/settlement-compensation.constants';
import { WITHDRAWAL_PENDING } from '../wallet/wallet.constants';
import {
  SIMULATION_STORE,
  type SimulationDiff,
  type SimulationEvent,
  type SimulationSnapshot,
  type SimulationStatus,
  type SimulationStore,
} from './simulation.types';

const WALLET_POINTS = 'points';
const WALLET_WITHDRAWABLE = 'withdrawable';
const WALLET_CONSUMPTION = 'consumption';

let eventSeq = 0;

/**
 * 时间仿真台。只做三件事：
 * 1. 记录时间轴（设置/清除覆盖、单步推进、每次的账务差分）；
 * 2. 单步推进：把业务时钟推到目标时刻，按序触发一次到期 job；
 * 3. 每步给出账务差分（钱包余额、现金账、关键计数）。
 *
 * 不修改任何业务规则，也不生成模拟数据。所有写操作要求
 * ALLOW_CLOCK_OVERRIDE=true，并且已有时钟覆盖（先设起点才能推进）。
 */
@Injectable()
export class SimulationService {
  constructor(
    private readonly clock: ClockService,
    private readonly runner: DueJobRunner,
    private readonly prisma: PrismaService,
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

    const event = await this.append('step', {
      from: view.override,
      to: target.toISOString(),
      byMinutes: input.byMinutes,
      jobsAttempted: true,
    }, diff);
    return { status: await this.status(), event };
  }

  async timeline(): Promise<{ events: SimulationEvent[] }> {
    this.assertEnabled();
    return { events: await this.store.list() };
  }

  async reset(): Promise<{ status: SimulationStatus }> {
    this.assertEnabled();
    await this.store.clear();
    return { status: await this.status() };
  }

  /** 双保险：env 开关（SIMULATION_ENABLED）关闭时一切仿真操作都拒绝。 */
  private assertEnabled(): void {
    if (!this.env.simulationEnabled) {
      throw new ForbiddenException('时间仿真台未启用（SIMULATION_ENABLED=false）');
    }
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
