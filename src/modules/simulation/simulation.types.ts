/** 仿真台的数据结构。只做时间可观测与可重放，不模拟任何分销行为。 */

export type SimulationAction =
  | 'set_clock'
  | 'clear_clock'
  | 'step'
  | 'advance'
  | 'register'
  | 'purchase'
  | 'role'
  | 'seed_tree'
  | 'reset'
  | 'reset_data';

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
    /** 本次造了多少人 / 多少单 / 任命了几个角色。 */
    created?: number;
    /** 时间推进时实际跑过 job 的时点个数。 */
    steps?: number;
  };
  /** 只有 step / advance 带差分。 */
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

/** 仿真总览：当前仿真时刻与业务存量，用于仿真台顶部卡片。 */
export interface SimulationOverview {
  clock: {
    now: string;
    realNow: string;
    source: 'real' | 'override';
  };
  users: {
    total: number;
    members: number;
  };
  orders: {
    total: number;
    paid: number;
    /** 已支付订单的实付合计（分）。 */
    paidAmountFen: number;
  };
  roles: {
    cofounders: number;
    studios: number;
    opsTeam: number;
  };
  businessDate: string;
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
