import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AppEnv } from '../src/config/app-env';
import { ClockService } from '../src/common/clock/clock.service';
import type { RedisClockOverrideStore } from '../src/common/clock/clock-override.store';

function env(allowClockOverride: boolean): AppEnv {
  return {
    nodeEnv: 'test',
    port: 3000,
    databaseUrl: 'mysql://u:p@127.0.0.1:3306/db',
    redisUrl: 'redis://127.0.0.1:6379',
    allowClockOverride,
    adminJwtSecret: 'test-secret-admin',
    miniProgramTokenSecret: 'test-secret-mini',
    marketingManagerMarketThresholdDefault: '10000',
    locked: Object.freeze({
      startupZoneUnitPriceFen: 1,
      filingWithdrawalRatioBps: 0,
      startupSalesAward: Object.freeze({ ratioBps: 0, withdrawableBps: 0, pointsBps: 10000 }),
      startupPointAward: Object.freeze({ ratioBps: 0, withdrawableBps: 0, pointsBps: 10000 }),
      mallSalesAward: Object.freeze({ ratioBps: 0, withdrawableBps: 0, pointsBps: 10000 }),
      mallPointAward: Object.freeze({ ratioBps: 0, withdrawableBps: 0, pointsBps: 10000 }),
      positionDividendShareTiers: Object.freeze([
        Object.freeze({ positionCode: 'leader', shares: 1 }),
      ]),
      redPacketDailyAccrualBps: 0,
      redPacketRoundPayThresholdFen: 0,
      redPacketRoundClaimCapFen: 0,
      cofounderDividendRatioBps: 0,
      studioDividendRatioBps: 0,
      operationsTeamDividendRatioBps: 0,
    }),
  };
}

function memoryStore() {
  let value: Date | null = null;
  return {
    get: jest.fn(async () => value),
    set: jest.fn(async (next: Date) => {
      value = next;
    }),
    clear: jest.fn(async () => {
      value = null;
    }),
  };
}

describe('ClockService', () => {
  it('ignores a stored override when the flag is off', async () => {
    const store = memoryStore();
    await store.set(new Date('2000-01-01T00:00:00.000Z'));
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(false));
    const resolved = await service.resolve();
    expect(resolved.source).toBe('real');
    expect(resolved.now.getFullYear()).toBeGreaterThan(2020);
    await expect(
      service.setOverride('2020-01-01T00:00:00.000Z', { hostHeader: 'test.local' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('rejects a public caller even when the flag is on', async () => {
    const store = memoryStore();
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(true));
    await expect(
      service.setOverride('2020-01-01T00:00:00.000Z', {
        hostHeader: 'mall.example.com',
        remoteAddress: '203.0.113.8',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('stores and reads one override for later jobs when the caller is allowed', async () => {
    const store = memoryStore();
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(true));
    await service.setOverride('2026-11-12T16:30:00.000Z', { hostHeader: 'test.local' });
    const resolved = await service.resolve();
    expect(resolved.source).toBe('override');
    expect(resolved.now.toISOString()).toBe('2026-11-12T16:30:00.000Z');
    await expect(service.bizDate()).resolves.toBe('2026-11-13');
    await expect(service.startOfDay()).resolves.toEqual(new Date('2026-11-12T16:00:00.000Z'));
    await service.clearOverride({ hostHeader: '127.0.0.1' });
    expect((await service.resolve()).source).toBe('real');
  });

  it('rejects an unparseable instant', async () => {
    const store = memoryStore();
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(true));
    await expect(
      service.setOverride('not-a-date', { hostHeader: 'localhost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
