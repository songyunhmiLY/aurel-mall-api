import type { Prisma } from '@prisma/client';

export const STUDIO_EXTERNAL_NAME_KEY = 'studio_external_name';
export const STUDIO_EXTERNAL_NAME_DEFAULT = '补贴';
export const STUDIO_EXTERNAL_NAME_MAX = 64;

export const STUDIO_STATUS_ACTIVE = 'active';
export const STUDIO_STATUS_CANCELLED = 'cancelled';

/** 奖励流水和可提现来源都用这个编码。分类默认是「系统激励」，内部名称是工作室补贴。 */
export const STUDIO_BIZ = 'studio';

export const STUDIO_BASE_GOODS = 'goods_total_fen';
export const STUDIO_BASE_PV = 'pv_fen';

export type Tx = Prisma.TransactionClient;

export function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
