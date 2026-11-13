import { NOTIFY_EVENTS, type NotifyEvent } from '../../common/notify/notify-intent';

/** 小程序「我的」页。未配置跳转时使用，避免微信在不传 page 时打开首页。 */
export const DEFAULT_NOTIFY_PAGE = 'pages/mine/index';

/** 腾讯云短信默认地域。管理端留空时发送用这个，密钥本身仍必须由管理端保存。 */
export const DEFAULT_SMS_REGION = 'ap-guangzhou';

export const NOTIFY_PAGE_MAX = 512;

export const DELIVERY_MODES = ['wechat', 'sms', 'both'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const NOTIFY_MODE_KEY = 'notify_delivery_mode';
export const NOTIFY_SMS_SECRET_ID_KEY = 'notify_sms_secret_id';
export const NOTIFY_SMS_SECRET_KEY_KEY = 'notify_sms_secret_key';
export const NOTIFY_SMS_SDK_APP_ID_KEY = 'notify_sms_sdk_app_id';
export const NOTIFY_SMS_SIGN_NAME_KEY = 'notify_sms_sign_name';
export const NOTIFY_SMS_REGION_KEY = 'notify_sms_region';

const EVENT_PARTS = ['enabled', 'wx_tpl', 'sms_tpl', 'page', 'slots'] as const;
export type NotifyEventPart = (typeof EVENT_PARTS)[number];

export function isDeliveryMode(value: string): value is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(value);
}

export function eventSettingKey(event: NotifyEvent, part: NotifyEventPart): string {
  return `notify_evt_${event}_${part}`;
}

export function notifySettingKeys(): string[] {
  const keys = [
    NOTIFY_MODE_KEY,
    NOTIFY_SMS_SECRET_ID_KEY,
    NOTIFY_SMS_SECRET_KEY_KEY,
    NOTIFY_SMS_SDK_APP_ID_KEY,
    NOTIFY_SMS_SIGN_NAME_KEY,
    NOTIFY_SMS_REGION_KEY,
  ];
  for (const event of NOTIFY_EVENTS) {
    for (const part of EVENT_PARTS) {
      keys.push(eventSettingKey(event, part));
    }
  }
  return keys;
}
