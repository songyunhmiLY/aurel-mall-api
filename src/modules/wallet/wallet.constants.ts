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

export function isWalletType(value: string): value is WalletType {
  return (WALLET_TYPES as readonly string[]).includes(value);
}
