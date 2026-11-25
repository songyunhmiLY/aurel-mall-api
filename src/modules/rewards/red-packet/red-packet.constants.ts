/** 首页福利入口文案。管理员可改，不放锁定配置。 */
export const WELFARE_ENTRY_COPY_KEY = 'welfare_entry_copy';

/** 首页福利入口图片。管理员可改，不放锁定配置。 */
export const WELFARE_ENTRY_IMAGE_KEY = 'welfare_entry_image_url';

export const WELFARE_ENTRY_COPY_MAX = 200;
export const WELFARE_ENTRY_IMAGE_MAX = 512;

/** 钱包流水、奖励流水和可提现显示来源都用这个编码。显示名默认是「系统红包」。 */
export const RED_PACKET_BIZ = 'red_packet';

/** 指定日期红包金额池的单日上限（分），防止误输入天量数字。 */
export const WELFARE_POOL_OVERRIDE_MAX_FEN = 2_147_483_647;
