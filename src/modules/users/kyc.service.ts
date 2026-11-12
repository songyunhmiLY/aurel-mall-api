import { Injectable } from '@nestjs/common';
import type { UserKyc } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KYC_STATUS_VERIFIED, normalizeKycInput, type KycInput } from './kyc.constants';

export interface KycView {
  verified: boolean;
  status: string | null;
  realName: string | null;
  idNumber: string | null;
  mobile: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
}

/**
 * 实名只在提现前需要。浏览、下单、消费账户划转不要调用 isVerified。
 * 后续提现代码用 isVerified 判断用户是否已核验。
 */
@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async isVerified(userId: bigint): Promise<boolean> {
    const row = await this.prisma.userKyc.findUnique({ where: { userId } });
    return row?.status === KYC_STATUS_VERIFIED;
  }

  async getForUser(userId: bigint): Promise<KycView> {
    const row = await this.prisma.userKyc.findUnique({ where: { userId } });
    return toView(row);
  }

  async submit(userId: bigint, input: KycInput): Promise<KycView> {
    const normalized = normalizeKycInput(input);
    const now = await this.clock.now();
    const existing = await this.prisma.userKyc.findUnique({ where: { userId } });
    if (!existing) {
      try {
        const created = await this.prisma.userKyc.create({
          data: {
            userId,
            realName: normalized.realName,
            idNumber: normalized.idNumber,
            mobile: normalized.mobile,
            status: KYC_STATUS_VERIFIED,
            submittedAt: now,
            updatedAt: now,
          },
        });
        return toView(created);
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    }
    const updated = await this.prisma.userKyc.update({
      where: { userId },
      data: {
        realName: normalized.realName,
        idNumber: normalized.idNumber,
        mobile: normalized.mobile,
        status: KYC_STATUS_VERIFIED,
        submittedAt: now,
        updatedAt: now,
      },
    });
    return toView(updated);
  }
}

function toView(row: UserKyc | null): KycView {
  if (!row) {
    return {
      verified: false,
      status: null,
      realName: null,
      idNumber: null,
      mobile: null,
      submittedAt: null,
      updatedAt: null,
    };
  }
  return {
    verified: row.status === KYC_STATUS_VERIFIED,
    status: row.status,
    realName: row.realName,
    idNumber: row.idNumber,
    mobile: row.mobile,
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
