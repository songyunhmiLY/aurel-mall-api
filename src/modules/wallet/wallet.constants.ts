export const WALLET_POINTS = 'points';
export const WALLET_WITHDRAWABLE = 'withdrawable';
export const WALLET_CONSUMPTION = 'consumption';

/** 锁定顺序固定，避免两笔支付互相等待。 */
export const WALLET_TYPES = [WALLET_CONSUMPTION, WALLET_POINTS, WALLET_WITHDRAWABLE] as const;

export type WalletType = (typeof WALLET_TYPES)[number];

export const HOLD_HELD = 'held';
export const HOLD_CAPTURED = 'captured';
export const HOLD_RELEASED = 'released';

export const LEDGER_CREDIT = 'credit';
export const LEDGER_DEBIT = 'debit';
export const LEDGER_ORDER_PAYMENT = 'order_payment';
export const LEDGER_CONSUMPTION_TRANSFER = 'consumption_transfer';
export const LEDGER_WITHDRAWAL_PAYOUT = 'withdrawal_payout';
export const LEDGER_MALL_REFUND = 'mall_refund';

/**
 * §4.1 可提现账户的入账来源。显示名相同的来源归成一个分类。
 * 不要在这张表之外再加来源。
 */
export const WITHDRAWAL_DISPLAY_SOURCES = [
  'cofounder',
  'studio',
  'operations',
  'red_packet',
  'startup_sales',
  'startup_points',
  'mall_sales',
  'mall_points',
  'filing_settlement',
  'position_dividend',
] as const;

export type WithdrawalDisplaySourceCode = (typeof WITHDRAWAL_DISPLAY_SOURCES)[number];

/** 新库和尚未配置过的来源使用这些显示名。管理端可以改。 */
export const WITHDRAWAL_DISPLAY_DEFAULTS: Record<WithdrawalDisplaySourceCode, string> = {
  cofounder: '系统奖励',
  studio: '系统激励',
  /** 运营团队分红。创业专区和商城是两笔流水，bizType 分别为 operations_startup、operations_mall。 */
  operations: '平台分红',
  red_packet: '系统红包',
  startup_sales: '销售激励',
  startup_points: '销售激励',
  mall_sales: '销售激励',
  mall_points: '销售激励',
  filing_settlement: '幸运返还',
  position_dividend: '业绩奖',
};

export const WITHDRAWAL_PENDING = 'pending';
export const WITHDRAWAL_REJECTED = 'rejected';
export const WITHDRAWAL_PAID = 'paid';

export const MIN_WITHDRAWAL_FEN = 10_000n;

export const CASH_OUTFLOW = 'outflow';
export const CASH_INFLOW = 'inflow';
export const CASH_WECHAT_REFUND = 'wechat_refund';
export const CASH_WITHDRAWAL_PAYOUT = 'withdrawal_payout';
/** 联合创始人开通的微信收款。不是商品销售。 */
export const CASH_COFOUNDER_ACTIVATION = 'cofounder_activation';

export function isWalletType(value: string): value is WalletType {
  return (WALLET_TYPES as readonly string[]).includes(value);
}

export function isWithdrawalDisplaySource(value: string): value is WithdrawalDisplaySourceCode {
  return (WITHDRAWAL_DISPLAY_SOURCES as readonly string[]).includes(value);
}
