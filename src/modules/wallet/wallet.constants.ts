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
 * 奖励流水里已经预留、并且可以进入可提现账户的来源。
 * TODO(§4.1): 官方七个默认显示名和来源映射不在本仓库，这里不预置中文名。
 * 默认显示名等于来源编码。管理端改成相同文本后，按显示名归成一个分类。
 * 确认需求前不要再增加来源。
 */
export const WITHDRAWAL_DISPLAY_SOURCES = [
  'startup_sales',
  'startup_points',
  'mall_sales',
  'mall_points',
  'position_dividend',
  'cofounder',
  'studio',
  'operations',
  'red_packet',
] as const;

export type WithdrawalDisplaySourceCode = (typeof WITHDRAWAL_DISPLAY_SOURCES)[number];

export const WITHDRAWAL_PENDING = 'pending';
export const WITHDRAWAL_REJECTED = 'rejected';
export const WITHDRAWAL_PAID = 'paid';

export const MIN_WITHDRAWAL_FEN = 10_000n;

export const CASH_OUTFLOW = 'outflow';
export const CASH_WECHAT_REFUND = 'wechat_refund';
export const CASH_WITHDRAWAL_PAYOUT = 'withdrawal_payout';

export function isWalletType(value: string): value is WalletType {
  return (WALLET_TYPES as readonly string[]).includes(value);
}

export function isWithdrawalDisplaySource(value: string): value is WithdrawalDisplaySourceCode {
  return (WITHDRAWAL_DISPLAY_SOURCES as readonly string[]).includes(value);
}
