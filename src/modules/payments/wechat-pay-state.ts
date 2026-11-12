export type PaymentStatus = 'pending' | 'success' | 'failed';

const FAIL_TRADE_STATES = new Set(['PAYERROR', 'CLOSED', 'REVOKED']);

/**
 * 支付状态机。
 * success 是终态。failed 之后若收到 SUCCESS，仍改为 success（款项已到）。
 * 退款、分账和资金路径合规不在这里处理。
 */
export function nextPaymentStatus(current: PaymentStatus, tradeState: string): PaymentStatus {
  if (current === 'success') {
    return 'success';
  }
  if (tradeState === 'SUCCESS') {
    return 'success';
  }
  if (current === 'failed') {
    return 'failed';
  }
  if (FAIL_TRADE_STATES.has(tradeState)) {
    return 'failed';
  }
  return 'pending';
}

export function assertPaymentStatus(value: string): PaymentStatus {
  if (value === 'pending' || value === 'success' || value === 'failed') {
    return value;
  }
  throw new Error(`未知支付状态: ${value}`);
}
