import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { parseAppEnv } from '../src/config/app-env';
import { LOCKED_RUNTIME_ENV_KEYS } from '../src/config/locked-runtime';

const example = parse(readFileSync(join(__dirname, '..', '.env.example')));
const compose = readFileSync(join(__dirname, '..', 'docker-compose.yml'), 'utf8');

describe('locked runtime config', () => {
  it('parses the documented example and freezes it', () => {
    const env = parseAppEnv(example);
    expect(env.allowClockOverride).toBe(false);
    expect(env.allowPreviewAuth).toBe(false);
    expect(env.wechatMiniAppId).toBeNull();
    expect(env.wechatMiniAppSecret).toBeNull();
    expect(env.adminBootstrapUsername).toBeNull();
    expect(env.adminBootstrapPassword).toBeNull();
    expect(env.wechatPayNotifyUrl).toBeNull();
    expect(env.port).toBe(3000);
    expect(env.marketingManagerMarketThresholdDefault).toBe('2000000');
    expect(env.locked.startupZoneUnitPriceFen).toBe(100_000);
    expect(env.locked.filingWithdrawalRatioBps).toBe(2000);
    expect(env.locked.filingDailyCheckTime).toBe('00:01');
    expect(env.locked.startupSalesRatioBps).toBe(500);
    expect(env.locked.startupPointRatioBps).toBe(200);
    expect(env.locked.startupAwardSplit).toEqual({
      withdrawableBps: 8500,
      pointsBps: 500,
      consumptionBps: 1000,
    });
    expect(env.locked.mallAwardSplit).toEqual({
      withdrawableBps: 8500,
      pointsBps: 1000,
      consumptionBps: 500,
    });
    expect(env.locked.redPacketDailyAccrualBps).toBe(300);
    expect(env.locked.redPacketRoundPayThresholdFen).toBe(500_000);
    expect(env.locked.redPacketRoundClaimCapFen).toBe(800_000);
    expect(env.locked.cofounderDividendRatioBps).toBe(200);
    expect(env.locked.cofounderStartupDividendRatioBps).toBe(200);
    expect(env.locked.cofounderMallDividendRatioBps).toBe(200);
    expect(env.locked.positionDividendPools.map((tier) => tier.positionCode)).toEqual([
      'marketing_manager',
      'senior_manager',
      'director',
      'senior_director',
      'chief',
    ]);
    expect(Object.isFrozen(env.locked)).toBe(true);
    expect(Object.isFrozen(env.locked.startupAwardSplit)).toBe(true);
    expect(() => {
      env.locked.startupZoneUnitPriceFen = 1;
    }).toThrow(TypeError);
    expect(env.locked).not.toHaveProperty('marketingManagerMarketThresholdDefault');
  });

  it('requires every locked key in the example and in compose', () => {
    for (const key of LOCKED_RUNTIME_ENV_KEYS) {
      expect(example[key]).toBeTruthy();
      expect(compose).toContain(key);
      const broken = { ...example };
      delete broken[key];
      expect(() => parseAppEnv(broken)).toThrow(key);
    }
  });

  it('rejects preview auth values other than true or false', () => {
    expect(() => parseAppEnv({ ...example, ALLOW_PREVIEW_AUTH: 'yes' })).toThrow(
      /ALLOW_PREVIEW_AUTH/,
    );
    expect(parseAppEnv({ ...example, ALLOW_PREVIEW_AUTH: 'true' }).allowPreviewAuth).toBe(true);
  });

  it('rejects a wallet split that does not add up to 10000', () => {
    expect(() => parseAppEnv({ ...example, STARTUP_AWARD_WITHDRAWABLE_BPS: '2000' })).toThrow(
      /STARTUP_AWARD/,
    );
  });

  it('rejects a filing check time that is not HH:mm', () => {
    expect(() => parseAppEnv({ ...example, FILING_DAILY_CHECK_TIME: '24:00' })).toThrow(
      /FILING_DAILY_CHECK_TIME/,
    );
  });

  it('treats admin bootstrap and the wechat notify url as optional', () => {
    expect(() =>
      parseAppEnv({ ...example, ADMIN_BOOTSTRAP_USERNAME: 'root', ADMIN_BOOTSTRAP_PASSWORD: '' }),
    ).toThrow(/同时/);
    expect(() =>
      parseAppEnv({
        ...example,
        ADMIN_BOOTSTRAP_USERNAME: 'root',
        ADMIN_BOOTSTRAP_PASSWORD: 'short',
      }),
    ).toThrow(/8 到 128/);
    const bootstrapped = parseAppEnv({
      ...example,
      ADMIN_BOOTSTRAP_USERNAME: 'root',
      ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass',
      ADMIN_BOOTSTRAP_DISPLAY_NAME: '平台',
      WECHAT_PAY_NOTIFY_URL: 'http://127.0.0.1:3000/api/v1/payments/wechat/notify',
    });
    expect(bootstrapped.adminBootstrapUsername).toBe('root');
    expect(bootstrapped.adminBootstrapDisplayName).toBe('平台');
    expect(bootstrapped.wechatPayNotifyUrl).toBe(
      'http://127.0.0.1:3000/api/v1/payments/wechat/notify',
    );
    expect(() =>
      parseAppEnv({ ...example, WECHAT_PAY_NOTIFY_URL: 'ftp://files.example.com/hook' }),
    ).toThrow(/WECHAT_PAY_NOTIFY_URL/);
  });

  it('lets the two cofounder rates override the shared fallback', () => {
    const overridden = parseAppEnv({
      ...example,
      COFOUNDER_STARTUP_DIVIDEND_RATIO_BPS: '250',
      COFOUNDER_MALL_DIVIDEND_RATIO_BPS: '150',
    });
    expect(overridden.locked.cofounderDividendRatioBps).toBe(200);
    expect(overridden.locked.cofounderStartupDividendRatioBps).toBe(250);
    expect(overridden.locked.cofounderMallDividendRatioBps).toBe(150);
    const blank = parseAppEnv({
      ...example,
      COFOUNDER_STARTUP_DIVIDEND_RATIO_BPS: ' ',
      COFOUNDER_MALL_DIVIDEND_RATIO_BPS: '',
    });
    expect(blank.locked.cofounderStartupDividendRatioBps).toBe(200);
    expect(blank.locked.cofounderMallDividendRatioBps).toBe(200);
  });

  it('rejects duplicate position codes', () => {
    expect(() =>
      parseAppEnv({
        ...example,
        POSITION_DIVIDEND_POOL_BPS: 'marketing_manager:800,marketing_manager:600',
      }),
    ).toThrow(/重复/);
  });
});
