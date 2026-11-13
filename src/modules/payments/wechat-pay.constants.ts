export const WECHAT_PAY_CHANNEL = 'wechat';

export const WECHAT_PAY_MCH_ID_KEY = 'wechat_pay_mch_id';
export const WECHAT_PAY_API_CERTIFICATE_KEY = 'wechat_pay_api_certificate';
export const WECHAT_PAY_API_V3_KEY_KEY = 'wechat_pay_api_v3_key';

export const WECHAT_PAY_SETTING_KEYS = [
  WECHAT_PAY_MCH_ID_KEY,
  WECHAT_PAY_API_CERTIFICATE_KEY,
  WECHAT_PAY_API_V3_KEY_KEY,
] as const;

export const PAYMENT_PURPOSE_ORDER = 'order';
export const PAYMENT_PURPOSE_COFOUNDER = 'cofounder_activation';

export function activePaymentSlot(orderId: bigint): string {
  return `order:${orderId.toString()}`;
}

export function activeCofounderSlot(userId: bigint): string {
  return `cofounder:${userId.toString()}`;
}
