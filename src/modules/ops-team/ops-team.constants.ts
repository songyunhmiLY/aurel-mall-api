import type { Prisma } from '@prisma/client';

export const OPS_TEAM_STATUS_ACTIVE = 'active';
export const OPS_TEAM_STATUS_CANCELLED = 'cancelled';

/** 全网席位。指定、改派、取消和计提都先锁这一行。 */
export const OPS_TEAM_SLOT = 1;

/** 在籍行的 active_slot。取消后改为 NULL，唯一索引因此只卡住一名持有人。 */
export const OPS_TEAM_ACTIVE_SLOT = 1;

/**
 * 可提现来源和奖励类型。显示分类默认是「平台分红」。
 * 创业专区和商城是两笔流水，用下面的 bizType 区分，不另开来源编码。
 */
export const OPS_TEAM_SOURCE = 'operations';
export const OPS_TEAM_REWARD = 'operations';
export const OPS_TEAM_BIZ_STARTUP = 'operations_startup';
export const OPS_TEAM_BIZ_MALL = 'operations_mall';

export const OPS_TEAM_BASE_GOODS = 'goods_total_fen';
export const OPS_TEAM_BASE_PV = 'pv_fen';

export type Tx = Prisma.TransactionClient;

export function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
