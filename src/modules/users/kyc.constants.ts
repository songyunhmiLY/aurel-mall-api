import { BadRequestException } from '@nestjs/common';

/** 格式校验通过后的实名状态。没有第三方征信。 */
export const KYC_STATUS_VERIFIED = 'verified';

const ID_NUMBER = /^\d{17}[\dX]$/;
const MOBILE = /^1\d{10}$/;

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
  const mobile = input.mobile.trim();
  if (!MOBILE.test(mobile)) {
    throw new BadRequestException('手机号格式不正确');
  }
  return { realName, idNumber, mobile };
}
