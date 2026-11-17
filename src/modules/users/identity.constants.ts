/**
 * user_identities.provider。
 * 本阶段实现登录的只有 wechat_mini。preview 只在 ALLOW_PREVIEW_AUTH 打开时可用。
 * wechat_oa、wechat_web、sms_phone 预留，不实现登录，避免以后加公众号、网站应用和短信登录时改表。
 * 不同微信入口的 openid 不是同一人，除非以后单独做 unionid 绑定。本阶段不按 unionid 合并。
 */
export const IDENTITY_PROVIDERS = {
  wechatMini: 'wechat_mini',
  wechatOa: 'wechat_oa',
  wechatWeb: 'wechat_web',
  smsPhone: 'sms_phone',
  preview: 'preview',
  systemRoot: 'system_root',
  /** 仿真台批量注册的用户。不能登录，只用于造数与演练。 */
  simulation: 'simulation',
} as const;

export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[keyof typeof IDENTITY_PROVIDERS];

/** 已预留、本阶段不实现登录的 provider。 */
export const RESERVED_LOGIN_PROVIDERS = [
  IDENTITY_PROVIDERS.wechatOa,
  IDENTITY_PROVIDERS.wechatWeb,
  IDENTITY_PROVIDERS.smsPhone,
] as const;

/** 官方根账户的预置邀请码。只留给根账户。其他会员入座时得到另外的 6 位数字码。 */
export const ROOT_INVITE_CODE = '000000';
export const LEGACY_ROOT_INVITE_CODE = 'ROOT';

export const ROOT_IDENTITY_IDENTIFIER = 'root';

export const ROOT_NICKNAME = '系统根账户';
