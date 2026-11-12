import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { maskApiV3Key, parseMerchantCertificateMaterial } from './wechat-pay-crypto';
import {
  WECHAT_PAY_API_CERTIFICATE_KEY,
  WECHAT_PAY_API_V3_KEY_KEY,
  WECHAT_PAY_MCH_ID_KEY,
  WECHAT_PAY_SETTING_KEYS,
} from './wechat-pay.constants';

export interface WechatPayCredentials {
  merchantId: string;
  apiV3Key: string;
  certificatePem: string;
  privateKeyPem: string;
  serialNumber: string;
}

export interface WechatPaySettingsView {
  configured: boolean;
  merchantId: string | null;
  apiV3KeyMasked: string | null;
  certificateConfigured: boolean;
  updatedAt: string | null;
}

export interface UpdateWechatPaySettingsInput {
  merchantId?: string;
  apiCertificate?: string;
  apiV3Key?: string;
}

@Injectable()
export class WechatPaySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async getView(): Promise<WechatPaySettingsView> {
    const raw = await this.readRaw();
    return toView(raw);
  }

  async update(
    input: UpdateWechatPaySettingsInput,
    adminUserId: bigint,
  ): Promise<WechatPaySettingsView> {
    if (
      input.merchantId === undefined &&
      input.apiCertificate === undefined &&
      input.apiV3Key === undefined
    ) {
      throw new BadRequestException('至少提供商户号、API 证书或 APIv3 密钥中的一项');
    }
    if (input.apiCertificate !== undefined) {
      try {
        parseMerchantCertificateMaterial(input.apiCertificate);
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'API 证书无效');
      }
    }
    const now = await this.clock.now();
    const writes: Array<[string, string]> = [];
    if (input.merchantId !== undefined) {
      writes.push([WECHAT_PAY_MCH_ID_KEY, input.merchantId]);
    }
    if (input.apiCertificate !== undefined) {
      writes.push([WECHAT_PAY_API_CERTIFICATE_KEY, input.apiCertificate]);
    }
    if (input.apiV3Key !== undefined) {
      writes.push([WECHAT_PAY_API_V3_KEY_KEY, input.apiV3Key]);
    }
    await this.prisma.$transaction(async (tx) => {
      for (const [settingKey, settingValue] of writes) {
        await tx.adminSetting.upsert({
          where: { settingKey },
          create: {
            settingKey,
            settingValue,
            updatedAt: now,
            updatedByAdminId: adminUserId,
          },
          update: {
            settingValue,
            updatedAt: now,
            updatedByAdminId: adminUserId,
          },
        });
      }
    });
    return this.getView();
  }

  async clear(): Promise<WechatPaySettingsView> {
    await this.prisma.adminSetting.deleteMany({
      where: { settingKey: { in: [...WECHAT_PAY_SETTING_KEYS] } },
    });
    return this.getView();
  }

  async isConfigured(): Promise<boolean> {
    return (await this.readCredentials()) !== null;
  }

  /** 仅供支付网关使用。不要把返回值写进接口响应。 */
  async readCredentials(): Promise<WechatPayCredentials | null> {
    const raw = await this.readRaw();
    if (!raw.merchantId || !raw.apiV3Key || !raw.apiCertificate || raw.apiV3Key.length !== 32) {
      return null;
    }
    try {
      const material = parseMerchantCertificateMaterial(raw.apiCertificate);
      return {
        merchantId: raw.merchantId,
        apiV3Key: raw.apiV3Key,
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
        serialNumber: material.serialNumber,
      };
    } catch {
      return null;
    }
  }

  private async readRaw(): Promise<RawWechatPaySettings> {
    const rows = await this.prisma.adminSetting.findMany({
      where: { settingKey: { in: [...WECHAT_PAY_SETTING_KEYS] } },
    });
    const values = new Map(rows.map((row) => [row.settingKey, row]));
    let updatedAt: Date | null = null;
    for (const row of rows) {
      if (!updatedAt || row.updatedAt > updatedAt) {
        updatedAt = row.updatedAt;
      }
    }
    return {
      merchantId: values.get(WECHAT_PAY_MCH_ID_KEY)?.settingValue ?? null,
      apiCertificate: values.get(WECHAT_PAY_API_CERTIFICATE_KEY)?.settingValue ?? null,
      apiV3Key: values.get(WECHAT_PAY_API_V3_KEY_KEY)?.settingValue ?? null,
      updatedAt,
    };
  }
}

interface RawWechatPaySettings {
  merchantId: string | null;
  apiCertificate: string | null;
  apiV3Key: string | null;
  updatedAt: Date | null;
}

function toView(raw: RawWechatPaySettings): WechatPaySettingsView {
  let certificateConfigured = false;
  if (raw.apiCertificate) {
    try {
      parseMerchantCertificateMaterial(raw.apiCertificate);
      certificateConfigured = true;
    } catch {
      certificateConfigured = false;
    }
  }
  const keyReady = raw.apiV3Key !== null && raw.apiV3Key.length === 32;
  return {
    configured: Boolean(raw.merchantId) && keyReady && certificateConfigured,
    merchantId: raw.merchantId,
    apiV3KeyMasked: maskApiV3Key(raw.apiV3Key),
    certificateConfigured,
    updatedAt: raw.updatedAt ? raw.updatedAt.toISOString() : null,
  };
}
