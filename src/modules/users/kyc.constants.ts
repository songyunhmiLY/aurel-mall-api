import { BadRequestException } from '@nestjs/common';

/** 格式与校验位通过后的实名状态。没有第三方征信。 */
export const KYC_STATUS_VERIFIED = 'verified';

const ID_NUMBER = /^\d{17}[\dX]$/;
const MOBILE = /^1\d{10}$/;

/** GB 11643 加权因子。 */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
/** GB 11643 校验码表，下标是前 17 位的加权和模 11。 */
const ID_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3'] as const;

export interface KycInput {
  realName: string;
  idNumber: string;
  mobile: string;
}

export interface NormalizedKycInput {
  realName: string;
  idNumber: string;
  mobile: string;
}

export function normalizeKycInput(input: KycInput): NormalizedKycInput {
  const realName = input.realName.trim();
  if (realName.length < 1 || realName.length > 64) {
    throw new BadRequestException('姓名不能为空');
  }
  const idNumber = input.idNumber.trim().toUpperCase();
  if (idNumber.length !== 18) {
    throw new BadRequestException('身份证号必须是 18 位');
  }
  if (!ID_NUMBER.test(idNumber)) {
    throw new BadRequestException('身份证号格式不正确');
  }
  if (!hasValidBirthDate(idNumber)) {
    throw new BadRequestException('身份证号内的出生日期不正确');
  }
  if (!hasValidCheckDigit(idNumber)) {
    throw new BadRequestException('身份证号校验位不正确');
  }
  const mobile = input.mobile.trim();
  if (!MOBILE.test(mobile)) {
    throw new BadRequestException('手机号格式不正确');
  }
  return { realName, idNumber, mobile };
}

/**
 * GB 11643 校验位。
 * 前 17 位按加权因子求和，模 11 得到的下标去查校验码表，必须等于第 18 位。
 * 这一条能挡掉绝大多数随手编的号码，成本为零，也不涉及任何外部服务。
 */
export function hasValidCheckDigit(idNumber: string): boolean {
  if (!ID_NUMBER.test(idNumber)) {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(idNumber[index]) * ID_WEIGHTS[index]!;
  }
  return ID_CHECK_CODES[sum % 11] === idNumber[17];
}

/** 第 7 到 14 位是 YYYYMMDD，要求是真实存在的日期。 */
export function hasValidBirthDate(idNumber: string): boolean {
  const year = Number(idNumber.slice(6, 10));
  const month = Number(idNumber.slice(10, 12));
  const day = Number(idNumber.slice(12, 14));
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= daysInMonth(year, month);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return MONTH_DAYS[month - 1]!;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
