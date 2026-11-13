import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    allowPreviewAuth: false,
    adminJwtSecret: 'test-secret-admin',
    wechatMiniAppId: null,
    wechatMiniAppSecret: null,
    miniProgramTokenSecret: 'test-secret-mini',
    adminBootstrapUsername: null,
    adminBootstrapPassword: null,
    adminBootstrapDisplayName: null,
    wechatPayNotifyUrl: null,
    marketingManagerMarketThresholdDefault: '2000000',
    locked: Object.freeze({
      startupZoneUnitPriceFen: 1,
      filingWithdrawalRatioBps: 0,
      filingDailyCheckTime: '00:01',
      startupSalesRatioBps: 0,
      startupPointRatioBps: 0,
      startupAwardSplit: Object.freeze({
        withdrawableBps: 8500,
        pointsBps: 500,
        consumptionBps: 1000,
      }),
      mallSalesRatioBps: 0,
      mallPointRatioBps: 0,
      mallAwardSplit: Object.freeze({
        withdrawableBps: 8500,
        pointsBps: 1000,
        consumptionBps: 500,
      }),
      positionDividendPools: Object.freeze([
        Object.freeze({ positionCode: 'marketing_manager', poolBps: 800 }),
      ]),
      redPacketDailyAccrualBps: 0,
      redPacketRoundPayThresholdFen: 0,
      redPacketRoundClaimCapFen: 0,
      cofounderDividendRatioBps: 0,
      cofounderStartupDividendRatioBps: 0,
      cofounderMallDividendRatioBps: 0,
      studioStartupSubsidyRatioBps: 0,
      studioMallSubsidyRatioBps: 0,
      opsTeamStartupDividendRatioBps: 0,
      opsTeamMallDividendRatioBps: 0,
      withdrawalFeeFen: 0,
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

describe('ClockService override switch', () => {
  it('ignores override requests and stored overrides when the switch is off', async () => {
    const store = memoryStore();
    await store.set(new Date('2000-01-01T00:00:00.000Z'));
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(false));
    const resolved = await service.resolve();
    expect(resolved.source).toBe('real');
    expect(resolved.now.getFullYear()).toBeGreaterThan(2020);
    expect(store.get).not.toHaveBeenCalled();

    await expect(service.setOverride('2020-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.clearOverride()).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.clear).not.toHaveBeenCalled();
    await expect(store.get()).resolves.toEqual(new Date('2000-01-01T00:00:00.000Z'));

    const view = await service.readOverride();
    expect(view.allowed).toBe(false);
    expect(view.source).toBe('real');
    expect(view.override).toBeNull();
  });

  it('allows override when the switch is on, without a host, address, or test key', async () => {
    const store = memoryStore();
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(true));
    await service.setOverride('2026-11-12T16:30:00.000Z');
    const resolved = await service.resolve();
    expect(resolved.source).toBe('override');
    expect(resolved.now.toISOString()).toBe('2026-11-12T16:30:00.000Z');
    await expect(service.bizDate()).resolves.toBe('2026-11-13');
    await expect(service.startOfDay()).resolves.toEqual(new Date('2026-11-12T16:00:00.000Z'));
    const view = await service.readOverride();
    expect(view.allowed).toBe(true);
    expect(view.override).toBe('2026-11-12T16:30:00.000Z');
    await service.clearOverride();
    expect((await service.resolve()).source).toBe('real');
  });

  it('keeps ignoring a previously stored override after the switch is turned off', async () => {
    const store = memoryStore();
    const enabled = new ClockService(store as unknown as RedisClockOverrideStore, env(true));
    await enabled.setOverride('2020-01-01T00:00:00.000Z');
    const disabled = new ClockService(store as unknown as RedisClockOverrideStore, env(false));
    expect((await disabled.resolve()).source).toBe('real');
    await expect(disabled.clearOverride()).rejects.toBeInstanceOf(ForbiddenException);
    expect((await enabled.resolve()).now.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('rejects an unparseable instant only when the switch is on', async () => {
    const store = memoryStore();
    const service = new ClockService(store as unknown as RedisClockOverrideStore, env(true));
    await expect(service.setOverride('not-a-date')).rejects.toBeInstanceOf(BadRequestException);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('does not gate override on hostname, lan address, or a test key', () => {
    const dir = join(__dirname, '..', 'src', 'common', 'clock');
    const source = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/192\.168/);
    expect(source).not.toMatch(/127\.0\.0\.1/);
    expect(source).not.toMatch(/localhost/i);
    expect(source).not.toMatch(/x-forwarded-host/i);
    expect(source).not.toMatch(/remoteAddress/);
    expect(source).not.toMatch(/testKey|TEST_KEY|x-test-key/i);
    expect(source).not.toMatch(/includes\(\s*['"]test['"]\s*\)/);
    expect(source).toMatch(/allowClockOverride/);
  });
});
