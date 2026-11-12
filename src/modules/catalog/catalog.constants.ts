import { BadRequestException } from '@nestjs/common';

export const PRODUCT_ZONE_STARTUP = 'startup';
export const PRODUCT_ZONE_MALL = 'mall';

export const PRODUCT_STATUS_DRAFT = 'draft';
export const PRODUCT_STATUS_ON = 'on';
export const PRODUCT_STATUS_OFF = 'off';

export const PRODUCT_ZONES = [PRODUCT_ZONE_STARTUP, PRODUCT_ZONE_MALL] as const;
export const PRODUCT_STATUSES = [
  PRODUCT_STATUS_DRAFT,
  PRODUCT_STATUS_ON,
  PRODUCT_STATUS_OFF,
] as const;

export const WARNING_PV_ABOVE_PRICE = 'PV 大于售价';

const MAX_INT = 2_147_483_647;

export function warningStartupPriceForced(unitPriceFen: number): string {
  return `创业专区售价已按锁定单价 ${unitPriceFen} 分保存`;
}

export function assertNonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INT) {
    throw new BadRequestException(`${label}必须是非负整数`);
  }
  return value;
}
