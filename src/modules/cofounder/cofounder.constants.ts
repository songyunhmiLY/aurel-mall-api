import type { Prisma } from '@prisma/client';

export const COFOUNDER_SETTINGS_KEY = 'cofounder_settings';
export const COFOUNDER_ENTRY_COPY_KEY = 'cofounder_entry_copy';
export const COFOUNDER_ENTRY_IMAGES_KEY = 'cofounder_entry_image_urls';
export const COFOUNDER_INTRO_TITLE_KEY = 'cofounder_intro_title';
export const COFOUNDER_INTRO_BODY_KEY = 'cofounder_intro_body';
export const COFOUNDER_INTRO_IMAGES_KEY = 'cofounder_intro_image_urls';

export const COFOUNDER_ENTRY_COPY_MAX = 500;
export const COFOUNDER_INTRO_TITLE_MAX = 200;
/** 介绍正文是富文本 HTML，放宽到 6 万字符。 */
export const COFOUNDER_INTRO_BODY_MAX = 60_000;
export const COFOUNDER_IMAGE_MAX = 512;
export const COFOUNDER_IMAGE_COUNT_MAX = 20;

export const COFOUNDER_STATUS_ACTIVE = 'active';
export const COFOUNDER_STATUS_CANCELLED = 'cancelled';
export const COFOUNDER_SOURCE_PAYMENT = 'payment';
export const COFOUNDER_SOURCE_APPOINTMENT = 'appointment';

export const ACTIVATION_PENDING = 'pending';
export const ACTIVATION_SUCCEEDED = 'succeeded';
export const ACTIVATION_FAILED = 'failed';

export const PAYOUT_IMMEDIATE = 'immediate';
export const PAYOUT_PERIODIC = 'periodic';
export const PAYOUT_POOL_TOTAL = 'pool_total';
export const PAYOUT_PER_PERSON = 'per_person';
export const PAYOUT_MODE_SWITCH = 'mode_switch';

export const PAYOUT_MODES = [
  PAYOUT_IMMEDIATE,
  PAYOUT_PERIODIC,
  PAYOUT_POOL_TOTAL,
  PAYOUT_PER_PERSON,
] as const;

export type PayoutMode = (typeof PAYOUT_MODES)[number];

export const SCHEDULE_DAILY = 'daily';
export const SCHEDULE_WEEKLY = 'weekly';
export const SCHEDULE_MONTHLY = 'monthly';
export const SCHEDULE_INTERVAL = 'interval';

export const SCHEDULE_CYCLES = [
  SCHEDULE_DAILY,
  SCHEDULE_WEEKLY,
  SCHEDULE_MONTHLY,
  SCHEDULE_INTERVAL,
] as const;

export type ScheduleCycle = (typeof SCHEDULE_CYCLES)[number];

/** 奖励流水和可提现来源都用这个编码。显示名默认是「系统奖励」。 */
export const COFOUNDER_BIZ = 'cofounder';

export const COFOUNDER_BASE_GOODS = 'goods_total_fen';
export const COFOUNDER_BASE_PV = 'pv_fen';

export const POOL_SLOT = 1;
export const MAX_FEN = 9223372036854775807n;
export const MAX_ACTIVATION_FEN = 2_147_483_647;
export const MAX_SEAT_CAP = 1_000_000;

export const BUTTON_ALREADY = 'already_enrolled';
export const BUTTON_NOT_MEMBER = 'not_member';
export const BUTTON_CAP_FULL = 'cap_full';
export const BUTTON_CLOSED = 'closed';
export const BUTTON_AMOUNT_UNSET = 'amount_unset';
export const BUTTON_OPEN = 'open';

/**
 * 取消审核页按奖励类型列出的累计入账。顺序固定。
 * 商城销售奖、商城见点奖、工作室补贴和运营团队分红按 rewardType 合计。
 * 运营团队的创业专区和商城在钱包里分成两笔，这里仍合成一行。
 */
export const COFOUNDER_AWARD_LINES = [
  { rewardType: 'startup_sales', label: '报单销售奖' },
  { rewardType: 'startup_points', label: '见点奖' },
  { rewardType: 'mall_sales', label: '商城销售奖' },
  { rewardType: 'mall_points', label: '商城见点奖' },
  { rewardType: 'position_dividend', label: '职位分红' },
  { rewardType: 'red_packet', label: '抢红包' },
  { rewardType: 'cofounder', label: '联合创始人分红' },
  { rewardType: 'studio', label: '工作室补贴' },
  { rewardType: 'operations', label: '运营团队分红' },
  { rewardType: 'filing_settlement', label: '幸运返还' },
] as const;

export interface CofounderSchedule {
  cycle: ScheduleCycle;
  time: string;
  weekday: number;
  monthDay: number;
  intervalDays: number;
  anchorDate: string;
}

export interface CofounderSettings {
  seatCap: number;
  userButtonOpen: boolean;
  activationAmountFen: bigint;
  payoutMode: PayoutMode;
  schedule: CofounderSchedule;
  poolThresholdFen: bigint;
  perPersonThresholdFen: bigint;
}

export function defaultCofounderSchedule(): CofounderSchedule {
  return {
    cycle: SCHEDULE_DAILY,
    time: '00:00',
    weekday: 1,
    monthDay: 1,
    intervalDays: 7,
    anchorDate: '2026-01-01',
  };
}

export function defaultCofounderSettings(): CofounderSettings {
  return {
    seatCap: 100,
    userButtonOpen: false,
    activationAmountFen: 0n,
    payoutMode: PAYOUT_IMMEDIATE,
    schedule: defaultCofounderSchedule(),
    poolThresholdFen: 0n,
    perPersonThresholdFen: 0n,
  };
}

export type Tx = Prisma.TransactionClient;

export function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
