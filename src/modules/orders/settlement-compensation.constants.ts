/** 结算补偿的状态、失败原因。 */

export const COMPENSATION_AUTO_RETRY = 'auto_retry';
export const COMPENSATION_AWAITING_OPERATION = 'awaiting_operation';
export const COMPENSATION_COMPLETED = 'completed';
export const COMPENSATION_REFUNDED = 'refunded';

export const COMPENSATION_ACTIVE_STATUSES = [
  COMPENSATION_AUTO_RETRY,
  COMPENSATION_AWAITING_OPERATION,
] as const;

export const COMPENSATION_REASON_CANCELLED = 'order_cancelled';
export const COMPENSATION_REASON_SEAT = 'seat_failure';
export const COMPENSATION_REASON_WALLET = 'wallet_shortfall';
export const COMPENSATION_REASON_TRANSIENT = 'transient';

/** 自动重试上限。超过后停在 auto_retry 等人工，避免无限空转。 */
export const COMPENSATION_MAX_RETRY = 60;

/** 两次自动重试的最小间隔。 */
export const COMPENSATION_RETRY_INTERVAL_MS = 60_000;
