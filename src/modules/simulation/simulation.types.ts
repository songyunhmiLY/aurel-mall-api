/** 仿真台的数据结构。只做时间可观测与可重放，不模拟任何分销行为。 */

export type SimulationAction = 'set_clock' | 'clear_clock' | 'step' | 'reset';

export interface SimulationSnapshot {
  /** 会员账户余额（分），按钱包类型汇总。 */
  wallet: {
    points: number;
    withdrawable: number;
    consumption: number;
    withdrawableFrozen: number;
    consumptionFrozen: number;
    pointsFrozen: number;
  };
  /** 平台现金账（分）。 */
  cash: {
    inflow: number;
    outflow: number;
  };
  counts: {
    orders: number;
    pendingWithdrawals: number;
    pendingCompensations: number;
  };
}

export interface SimulationDiff {
  wallet: SimulationSnapshot['wallet'];
  cash: SimulationSnapshot['cash'];
  counts: SimulationSnapshot['counts'];
}

export interface SimulationEvent {
  id: string;
  /** 事件记录时刻（该时刻的业务时钟读数）。 */
  at: string;
  action: SimulationAction;
  detail: {
    from?: string | null;
    to?: string | null;
    byMinutes?: number;
    jobsAttempted?: boolean;
  };
  /** 只有 step 带差分。 */
  diff: SimulationDiff | null;
}

export interface SimulationStatus {
  clock: {
    allowed: boolean;
    source: 'real' | 'override';
    now: string;
    override: string | null;
  };
  timelineCount: number;
}

export interface SimulationStore {
  append(event: SimulationEvent): Promise<void>;
  /** 返回按时间升序的全部事件（存储层已裁剪上限）。 */
  list(): Promise<SimulationEvent[]>;
  clear(): Promise<void>;
}

export const SIMULATION_STORE = Symbol('SIMULATION_STORE');

/** 时间轴最多保留的事件数。 */
export const SIMULATION_TIMELINE_CAP = 500;
