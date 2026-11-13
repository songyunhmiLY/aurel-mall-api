import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KYC_STATUS_VERIFIED } from '../users/kyc.constants';
import { IDENTITY_PROVIDERS } from '../users/identity.constants';
import { toE164 } from './phone-e164';

export interface NotifyRecipient {
  openid: string | null;
  phoneE164: string | null;
}

export interface NotificationDirectory {
  load(userIds: readonly bigint[]): Promise<Map<string, NotifyRecipient>>;
  orderNos(orderIds: readonly bigint[]): Promise<Map<string, string>>;
}

@Injectable()
export class PrismaNotificationDirectory implements NotificationDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async load(userIds: readonly bigint[]): Promise<Map<string, NotifyRecipient>> {
    const unique = uniqueIds(userIds);
    const result = new Map<string, NotifyRecipient>();
    if (unique.length === 0) {
      return result;
    }
    const [users, identities, kycs] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: unique } } }),
      this.prisma.userIdentity.findMany({
        where: { userId: { in: unique }, provider: IDENTITY_PROVIDERS.wechatMini },
        orderBy: { id: 'asc' },
      }),
      this.prisma.userKyc.findMany({
        where: { userId: { in: unique }, status: KYC_STATUS_VERIFIED },
      }),
    ]);
    const openidByUser = new Map<string, string>();
    for (const identity of identities) {
      const key = identity.userId.toString();
      if (!openidByUser.has(key) && identity.identifier.length > 0) {
        openidByUser.set(key, identity.identifier);
      }
    }
    const kycPhone = new Map<string, string>();
    for (const kyc of kycs) {
      kycPhone.set(kyc.userId.toString(), kyc.mobile);
    }
    for (const user of users) {
      const key = user.id.toString();
      result.set(key, {
        openid: openidByUser.get(key) ?? null,
        phoneE164: toE164(user.phone) ?? toE164(kycPhone.get(key)),
      });
    }
    return result;
  }

  async orderNos(orderIds: readonly bigint[]): Promise<Map<string, string>> {
    const unique = uniqueIds(orderIds);
    const result = new Map<string, string>();
    if (unique.length === 0) {
      return result;
    }
    const rows = await this.prisma.order.findMany({
      where: { id: { in: unique } },
      select: { id: true, orderNo: true },
    });
    for (const row of rows) {
      result.set(row.id.toString(), row.orderNo);
    }
    return result;
  }
}

function uniqueIds(ids: readonly bigint[]): bigint[] {
  const seen = new Set<string>();
  const unique: bigint[] = [];
  for (const id of ids) {
    const key = id.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(id);
  }
  return unique;
}
