import { BadRequestException } from '@nestjs/common';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { WechatPaySettingsService } from '../src/modules/payments/wechat-pay-settings.service';
import {
  WECHAT_PAY_API_CERTIFICATE_KEY,
  WECHAT_PAY_API_V3_KEY_KEY,
  WECHAT_PAY_MCH_ID_KEY,
} from '../src/modules/payments/wechat-pay.constants';
import { generateMerchantCertificate } from './support/test-merchant-certificate';

const API_V3_KEY = '0123456789abcdef0123456789abcdef';

interface SettingRow {
  settingKey: string;
  settingValue: string;
  updatedAt: Date;
  updatedByAdminId: bigint | null;
}

interface SettingsDb {
  rows: Map<string, SettingRow>;
  adminSetting: {
    findMany: (args: { where: { settingKey: { in: string[] } } }) => Promise<SettingRow[]>;
    upsert: (args: {
      where: { settingKey: string };
      create: SettingRow;
      update: Partial<SettingRow>;
    }) => Promise<SettingRow>;
    deleteMany: (args: { where: { settingKey: { in: string[] } } }) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: SettingsDb) => Promise<T>) => Promise<T>;
}

function memorySettings(): SettingsDb {
  const rows = new Map<string, SettingRow>();
  const api: SettingsDb = {
    adminSetting: {
      findMany: async ({ where }: { where: { settingKey: { in: string[] } } }) =>
        [...rows.values()].filter((row) => where.settingKey.in.includes(row.settingKey)),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { settingKey: string };
        create: SettingRow;
        update: Partial<SettingRow>;
      }) => {
        const existing = rows.get(where.settingKey);
        if (!existing) {
          rows.set(where.settingKey, create);
          return create;
        }
        const next = { ...existing, ...update };
        rows.set(where.settingKey, next);
        return next;
      },
      deleteMany: async ({ where }: { where: { settingKey: { in: string[] } } }) => {
        let count = 0;
        for (const key of where.settingKey.in) {
          if (rows.delete(key)) {
            count += 1;
          }
        }
        return { count };
      },
    },
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>): Promise<T> {
      return fn(api);
    },
    rows,
  };
  return api;
}

describe('wechat pay settings', () => {
  const certificate = generateMerchantCertificate();
  const now = new Date('2026-11-13T02:00:00.000Z');
  const clock = { now: async () => now, instant: (ms: number) => new Date(ms) };

  it('masks secrets and stays unconfigured until merchant, certificate, and key are all valid', async () => {
    const db = memorySettings();
    const service = new WechatPaySettingsService(
      db as unknown as PrismaService,
      clock as unknown as ClockService,
    );
    const partial = await service.update({ merchantId: '1900000109' }, 3n);
    expect(partial.configured).toBe(false);
    expect(partial.merchantId).toBe('1900000109');
    expect(partial.certificateConfigured).toBe(false);
    expect(partial.apiV3KeyMasked).toBeNull();

    await expect(
      service.update({ apiCertificate: 'not-a-certificate' }, 3n),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.rows.has(WECHAT_PAY_API_CERTIFICATE_KEY)).toBe(false);

    const saved = await service.update(
      { apiCertificate: certificate.bundle, apiV3Key: API_V3_KEY },
      3n,
    );
    expect(saved.configured).toBe(true);
    expect(saved.certificateConfigured).toBe(true);
    expect(saved.apiV3KeyMasked).toBe(`${'*'.repeat(28)}cdef`);
    const body = JSON.stringify(saved);
    expect(body).not.toContain(API_V3_KEY);
    expect(body).not.toContain('PRIVATE KEY');
    expect(body).not.toContain('BEGIN CERTIFICATE');
    expect(db.rows.get(WECHAT_PAY_API_V3_KEY_KEY)?.settingValue).toBe(API_V3_KEY);
    expect(db.rows.get(WECHAT_PAY_MCH_ID_KEY)?.updatedByAdminId).toBe(3n);

    const credentials = await service.readCredentials();
    expect(credentials?.merchantId).toBe('1900000109');
    expect(credentials?.serialNumber).toMatch(/^[0-9A-F]+$/);

    const cleared = await service.clear();
    expect(cleared.configured).toBe(false);
    expect(cleared.merchantId).toBeNull();
    expect(await service.readCredentials()).toBeNull();
  });
});
