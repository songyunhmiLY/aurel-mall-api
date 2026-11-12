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
    expect(env.adminBootstrapUsername).toBeNull();
    expect(env.adminBootstrapPassword).toBeNull();
    expect(env.wechatPayNotifyUrl).toBeNull();
    expect(env.port).toBe(3000);
    expect(env.marketingManagerMarketThresholdDefault).toBe('10000');
    expect(env.locked.startupZoneUnitPriceFen).toBe(100_000);
    expect(env.locked.redPacketRoundPayThresholdFen).toBe(500_000);
    expect(env.locked.redPacketRoundClaimCapFen).toBe(800_000);
    expect(env.locked.positionDividendShareTiers.map((tier) => tier.positionCode)).toEqual([
      'leader',
      'manager',
      'director',
    ]);
    expect(Object.isFrozen(env.locked)).toBe(true);
    expect(Object.isFrozen(env.locked.startupSalesAward)).toBe(true);
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

  it('rejects a wallet split that does not add up to 10000', () => {
    expect(() => parseAppEnv({ ...example, STARTUP_SALES_AWARD_WITHDRAWABLE_BPS: '2000' })).toThrow(
      /STARTUP_SALES_AWARD/,
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

  it('rejects duplicate position codes', () => {
    expect(() =>
      parseAppEnv({ ...example, POSITION_DIVIDEND_SHARE_TIERS: 'leader:1,leader:2' }),
    ).toThrow(/重复/);
  });
});
