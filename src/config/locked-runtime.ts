export interface AwardRule {
  ratioBps: number;
  withdrawableBps: number;
  pointsBps: number;
}

export interface PositionDividendTier {
  positionCode: string;
  shares: number;
}

/**
 * 需求 §1.1 中不允许在管理端修改的运行时配置。
 * 只在进程启动时从环境变量解析一次，对象被冻结。
 * 比例单位是万分比：10000 = 100%。金额单位是分。
 */
export interface LockedRuntimeConfig {
  startupZoneUnitPriceFen: number;
  filingWithdrawalRatioBps: number;
  startupSalesAward: AwardRule;
  startupPointAward: AwardRule;
  mallSalesAward: AwardRule;
  mallPointAward: AwardRule;
  positionDividendShareTiers: readonly PositionDividendTier[];
  redPacketDailyAccrualBps: number;
  redPacketRoundPayThresholdFen: number;
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
  'STARTUP_SALES_AWARD_RATIO_BPS',
  'STARTUP_SALES_AWARD_WITHDRAWABLE_BPS',
  'STARTUP_SALES_AWARD_POINTS_BPS',
  'STARTUP_POINT_AWARD_RATIO_BPS',
  'STARTUP_POINT_AWARD_WITHDRAWABLE_BPS',
  'STARTUP_POINT_AWARD_POINTS_BPS',
  'MALL_SALES_AWARD_RATIO_BPS',
  'MALL_SALES_AWARD_WITHDRAWABLE_BPS',
  'MALL_SALES_AWARD_POINTS_BPS',
  'MALL_POINT_AWARD_RATIO_BPS',
  'MALL_POINT_AWARD_WITHDRAWABLE_BPS',
  'MALL_POINT_AWARD_POINTS_BPS',
  'POSITION_DIVIDEND_SHARE_TIERS',
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

export function parseLockedRuntimeConfig(source: NodeJS.ProcessEnv): LockedRuntimeConfig {
  const startupSalesAward = readAward(source, 'STARTUP_SALES_AWARD');
  const startupPointAward = readAward(source, 'STARTUP_POINT_AWARD');
  const mallSalesAward = readAward(source, 'MALL_SALES_AWARD');
  const mallPointAward = readAward(source, 'MALL_POINT_AWARD');
  const positionDividendShareTiers = readPositionTiers(source.POSITION_DIVIDEND_SHARE_TIERS);

  return Object.freeze({
    startupZoneUnitPriceFen: readInt(source, 'STARTUP_ZONE_UNIT_PRICE_FEN', { min: 0 }),
    filingWithdrawalRatioBps: readInt(source, 'FILING_WITHDRAWAL_RATIO_BPS', {
      min: 0,
      max: BPS_MAX,
    }),
    startupSalesAward,
    startupPointAward,
    mallSalesAward,
    mallPointAward,
    positionDividendShareTiers,
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

function readAward(source: NodeJS.ProcessEnv, prefix: string): AwardRule {
  const ratioBps = readInt(source, `${prefix}_RATIO_BPS`, { min: 0, max: BPS_MAX });
  const withdrawableBps = readInt(source, `${prefix}_WITHDRAWABLE_BPS`, { min: 0, max: BPS_MAX });
  const pointsBps = readInt(source, `${prefix}_POINTS_BPS`, { min: 0, max: BPS_MAX });
  const split = withdrawableBps + pointsBps;
  if (split !== BPS_MAX) {
    throw new Error(`${prefix} 钱包拆分须合计 ${BPS_MAX}，当前为 ${split}`);
  }
  return Object.freeze({ ratioBps, withdrawableBps, pointsBps });
}

function readPositionTiers(raw: string | undefined): readonly PositionDividendTier[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('缺少环境变量 POSITION_DIVIDEND_SHARE_TIERS');
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 32) {
    throw new Error('POSITION_DIVIDEND_SHARE_TIERS 需要 1 到 32 个档位');
  }

  const tiers = parts.map((part) => {
    const pieces = part.split(':');
    if (pieces.length !== 2) {
      throw new Error(`职位分红档位格式错误: ${part}，应为 code:shares`);
    }
    const positionCode = pieces[0]?.trim() ?? '';
    const sharesRaw = pieces[1]?.trim() ?? '';
    if (!POSITION_CODE.test(positionCode)) {
      throw new Error(`职位编码不合法: ${positionCode}`);
    }
    if (!/^\d+$/.test(sharesRaw)) {
      throw new Error(`职位份额必须是正整数: ${part}`);
    }
    const shares = Number(sharesRaw);
    if (!Number.isSafeInteger(shares) || shares < 1) {
      throw new Error(`职位份额必须是正整数: ${part}`);
    }
    return Object.freeze({ positionCode, shares });
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
