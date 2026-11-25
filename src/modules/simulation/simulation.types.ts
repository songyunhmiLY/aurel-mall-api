/** 仿真台的数据结构。只做时间可观测与可重放，不模拟任何分销行为。 */

export type SimulationAction =
  | 'set_clock'
  | 'clear_clock'
  | 'step'
  | 'advance'
  | 'register'
  | 'purchase'
  | 'role'
  | 'red_packet_signup'
  | 'reset';

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
    /** 本次造了多少人 / 多少单 / 任命了几个角色 / 报名成功人数。 */
    created?: number;
    /** 红包报名：当天已报过的人数 / 未报上的人数。 */
    already?: number;
    skipped?: number;
    /** 时间推进时实际跑过 job 的时点个数。 */
    steps?: number;
    /** 本次推进填写的红包池：命中的业务日、金额（分）与是否真的结算用上。 */
    redPacketBizDate?: string;
    redPacketPoolFen?: string;
    redPacketApplied?: boolean;
  };
  /** 只有 step / advance 带差分。 */
  diff: SimulationDiff | null;
}

/** 推进时填写的演练红包池结果。 */
export interface SimulationRedPacketPool {
  bizDate: string;
  /** 十进制分字符串。 */
  amountFen: string;
  /** 该业务日在本次推进中真的结算了，金额才生效。 */
  applied: boolean;
}

/**
 * 演练页「红包池」上下文：当前仿真日的结算时刻与现有规则。
 * 默认池 = 当日创业专区已支付销售额 × 计提比例，仅作展示，随订单变化。
 */
export interface SimulationRedPacketPoolContext {
  bizDate: string;
  /** 这一天真正结算的时刻（次日检查钟点，ISO）。 */
  settleAt: string;
  /** 这一天是否已结算（已结算则再填金额不会生效）。 */
  settled: boolean;
  /** 管理后台为该日设置的金额池（分）；未设置为 null。 */
  adminAmountFen: string | null;
  signupCount: number;
  /** 默认计提比例，万分比（300 = 3%）。 */
  accrualBps: number;
  salesFen: string;
  defaultPoolFen: string;
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
  /**
   * 全网公排：已完成报单数、已返现的序号、尚未参与公排的创业子单数。
   * 一个订单可拆出多个子单（每件一份），这里按子单计数，不按订单笔数。
   */
  filings: {
    completed: number;
    settledSequences: number[];
    unfiledSubOrders: number;
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

/** 用户树节点上的用户信息：昵称、身份与三个钱包可用余额（分）。 */
export interface SimulationTreeUser {
  userId: string;
  nickname: string;
  identities: string[];
  wallets: {
    withdrawable: number;
    points: number;
    consumption: number;
  };
}

/** 树边：parentId 为空表示根。 */
export interface SimulationTreeEdge {
  userId: string;
  parentId: string | null;
}

/** 已进入公排的报单：sequence 是全局序号。 */
export interface SimulationFilingInfo {
  filingNo: string;
  sequence: number | null;
  bizDate: string | null;
  status: string;
  amountFen: number;
}

/** 已支付但尚未报单的创业专区订单（按订单聚合）。 */
export interface SimulationUnfiledOrder {
  orderNo: string;
  paidAt: string;
  /** 该订单拆出的报单资格件数。 */
  units: number;
  amountFen: number;
}

/** 演练用户树：两棵树的边 + 每个用户的展示信息 + 节点提示用的报单数据。 */
export interface SimulationUsersTree {
  users: SimulationTreeUser[];
  invite: SimulationTreeEdge[];
  market: SimulationTreeEdge[];
  filings: Record<string, SimulationFilingInfo[]>;
  unfiled: Record<string, SimulationUnfiledOrder[]>;
}

/** 钱包流水明细（用于节点点击后的账务变动列表）。 */
export interface SimulationLedgerEntry {
  id: string;
  occurredAt: string;
  walletType: string;
  direction: string;
  amountFen: number;
  balanceAfterFen: number;
  bizType: string;
  bizId: string;
  sourceCode: string | null;
}
