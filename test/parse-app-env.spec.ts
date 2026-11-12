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

  it('rejects duplicate position codes', () => {
    expect(() =>
      parseAppEnv({ ...example, POSITION_DIVIDEND_SHARE_TIERS: 'leader:1,leader:2' }),
    ).toThrow(/重复/);
  });
});
