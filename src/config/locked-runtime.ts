export interface WalletSplit {
  withdrawableBps: number;
  pointsBps: number;
  consumptionBps: number;
}

export interface PositionPoolTier {
  positionCode: string;
  /** 该档占平台商城 PV 的万分比。各档不必合计 10000，空档留在系统。 */
  poolBps: number;
}

/**
 * 需求 §1.1 中不允许在管理端修改的运行时配置。
 * 只在进程启动时从环境变量解析一次，对象被冻结。
 * 比例单位是万分比：10000 = 100%。金额单位是分。
 *
 * 创业专区销售奖和见点奖共用 startupAwardSplit。
 * 商城销售奖、商城见点奖和职位分红共用 mallAwardSplit。
 * positionDividendPools 按从低到高排列：第一档是营销经理池，不与更高职位叠加；
 * 其后每一档包含同时达到更高职位的会员。
 */
export interface LockedRuntimeConfig {
  startupZoneUnitPriceFen: number;
  filingWithdrawalRatioBps: number;
  /** 每日报单检查的上海时间，HH:mm。默认 00:01。不是管理端配置。 */
  filingDailyCheckTime: string;
  startupSalesRatioBps: number;
  startupPointRatioBps: number;
  startupAwardSplit: WalletSplit;
  mallSalesRatioBps: number;
  mallPointRatioBps: number;
  mallAwardSplit: WalletSplit;
  positionDividendPools: readonly PositionPoolTier[];
  /** 当日创业专区商品金额计提进红包池的万分比。官方示例 300 = 3%。 */
  redPacketDailyAccrualBps: number;
  /** 累计微信支付实付每满 K 开启一轮。单位分。官方示例 500000。 */
  redPacketRoundPayThresholdFen: number;
  /** 每开启一轮增加的领取上限 C。单位分。累计已领不按轮清零。官方示例 800000。 */
  redPacketRoundClaimCapFen: number;
  cofounderDividendRatioBps: number;
  studioDividendRatioBps: number;
  operationsTeamDividendRatioBps: number;
  /**
   * 提现手续费，单位分。打款时从申请金额里减去当时的这个值。
   * TODO: 需求 §1.1 的仓库清单里没有这项。任务要求手续费来自锁定配置，
   * 且实付 = 申请金额 − 手续费，因此按固定分而不是比例解析。正式金额未确认。
   */
  withdrawalFeeFen: number;
}

export const LOCKED_RUNTIME_ENV_KEYS = [
  'STARTUP_ZONE_UNIT_PRICE_FEN',
  'FILING_WITHDRAWAL_RATIO_BPS',
  'FILING_DAILY_CHECK_TIME',
  'STARTUP_SALES_AWARD_RATIO_BPS',
  'STARTUP_POINT_AWARD_RATIO_BPS',
  'STARTUP_AWARD_WITHDRAWABLE_BPS',
  'STARTUP_AWARD_POINTS_BPS',
  'STARTUP_AWARD_CONSUMPTION_BPS',
  'MALL_SALES_AWARD_RATIO_BPS',
  'MALL_POINT_AWARD_RATIO_BPS',
  'MALL_AWARD_WITHDRAWABLE_BPS',
  'MALL_AWARD_POINTS_BPS',
  'MALL_AWARD_CONSUMPTION_BPS',
  'POSITION_DIVIDEND_POOL_BPS',
  'RED_PACKET_DAILY_ACCRUAL_BPS',
  'RED_PACKET_ROUND_PAY_THRESHOLD_FEN',
  'RED_PACKET_ROUND_CLAIM_CAP_FEN',
  'COFOUNDER_DIVIDEND_RATIO_BPS',
  'STUDIO_DIVIDEND_RATIO_BPS',
  'OPERATIONS_TEAM_DIVIDEND_RATIO_BPS',
  'WITHDRAWAL_FEE_FEN',
] as const;

const BPS_MAX = 10_000;
const POSITION_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseLockedRuntimeConfig(source: NodeJS.ProcessEnv): LockedRuntimeConfig {
  const startupAwardSplit = readSplit(source, 'STARTUP_AWARD');
  const mallAwardSplit = readSplit(source, 'MALL_AWARD');
  const positionDividendPools = readPositionPools(source.POSITION_DIVIDEND_POOL_BPS);

  return Object.freeze({
    startupZoneUnitPriceFen: readInt(source, 'STARTUP_ZONE_UNIT_PRICE_FEN', { min: 0 }),
    filingWithdrawalRatioBps: readInt(source, 'FILING_WITHDRAWAL_RATIO_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    filingDailyCheckTime: readClockTime(source, 'FILING_DAILY_CHECK_TIME'),
    startupSalesRatioBps: readInt(source, 'STARTUP_SALES_AWARD_RATIO_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    startupPointRatioBps: readInt(source, 'STARTUP_POINT_AWARD_RATIO_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    startupAwardSplit,
    mallSalesRatioBps: readInt(source, 'MALL_SALES_AWARD_RATIO_BPS', { min: 0, max: BPS_MAX }),
    mallPointRatioBps: readInt(source, 'MALL_POINT_AWARD_RATIO_BPS', { min: 0, max: BPS_MAX }),
    mallAwardSplit,
    positionDividendPools,
    redPacketDailyAccrualBps: readInt(source, 'RED_PACKET_DAILY_ACCRUAL_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    redPacketRoundPayThresholdFen: readInt(source, 'RED_PACKET_ROUND_PAY_THRESHOLD_FEN', {
      min: 0,
    }),
    redPacketRoundClaimCapFen: readInt(source, 'RED_PACKET_ROUND_CLAIM_CAP_FEN', { min: 0 }),
    cofounderDividendRatioBps: readInt(source, 'COFOUNDER_DIVIDEND_RATIO_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    studioDividendRatioBps: readInt(source, 'STUDIO_DIVIDEND_RATIO_BPS', { min: 0, max: BPS_MAX }),
    operationsTeamDividendRatioBps: readInt(source, 'OPERATIONS_TEAM_DIVIDEND_RATIO_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    withdrawalFeeFen: readInt(source, 'WITHDRAWAL_FEE_FEN', { min: 0 }),
  });
}

function readSplit(source: NodeJS.ProcessEnv, prefix: string): WalletSplit {
  const withdrawableBps = readInt(source, `${prefix}_WITHDRAWABLE_BPS`, { min: 0, max: BPS_MAX });
  const pointsBps = readInt(source, `${prefix}_POINTS_BPS`, { min: 0, max: BPS_MAX });
  const consumptionBps = readInt(source, `${prefix}_CONSUMPTION_BPS`, { min: 0, max: BPS_MAX });
  const split = withdrawableBps + pointsBps + consumptionBps;
  if (split !== BPS_MAX) {
    throw new Error(`${prefix} 钱包拆分须合计 ${BPS_MAX}，当前为 ${split}`);
  }
  return Object.freeze({ withdrawableBps, pointsBps, consumptionBps });
}

function readClockTime(source: NodeJS.ProcessEnv, key: string): string {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`缺少环境变量 ${key}`);
  }
  const value = raw.trim();
  if (!CLOCK_TIME.test(value)) {
    throw new Error(`环境变量 ${key} 必须是 HH:mm`);
  }
  return value;
}

function readPositionPools(raw: string | undefined): readonly PositionPoolTier[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('缺少环境变量 POSITION_DIVIDEND_POOL_BPS');
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 32) {
    throw new Error('POSITION_DIVIDEND_POOL_BPS 需要 1 到 32 个档位');
  }

  const tiers = parts.map((part) => {
    const pieces = part.split(':');
    if (pieces.length !== 2) {
      throw new Error(`职位分红档位格式错误: ${part}，应为 code:bps`);
    }
    const positionCode = pieces[0]?.trim() ?? '';
    const bpsRaw = pieces[1]?.trim() ?? '';
    if (!POSITION_CODE.test(positionCode)) {
      throw new Error(`职位编码不合法: ${positionCode}`);
    }
    if (!/^\d+$/.test(bpsRaw)) {
      throw new Error(`职位分红比例必须是非负整数: ${part}`);
    }
    const poolBps = Number(bpsRaw);
    if (!Number.isSafeInteger(poolBps) || poolBps < 0 || poolBps > BPS_MAX) {
      throw new Error(`职位分红比例必须是 0 到 ${BPS_MAX}: ${part}`);
    }
    return Object.freeze({ positionCode, poolBps });
  });

  const codes = new Set(tiers.map((tier) => tier.positionCode));
  if (codes.size !== tiers.length) {
    throw new Error('职位分红档位编码重复');
  }
  return Object.freeze(tiers);
}

function readInt(
  source: NodeJS.ProcessEnv,
  key: string,
  bounds: { min: number; max?: number },
): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`缺少环境变量 ${key}`);
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`环境变量 ${key} 必须是非负整数`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new Error(`环境变量 ${key} 超出安全整数范围`);
  }
  if (value < bounds.min) {
    throw new Error(`环境变量 ${key} 不能小于 ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`环境变量 ${key} 不能大于 ${bounds.max}`);
  }
  return value;
}
