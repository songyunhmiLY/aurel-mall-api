import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { MiniProgramTokenService } from '../../src/common/auth/mini-program-token.service';
import type { ClockService } from '../../src/common/clock/clock.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import type { AppEnv } from '../../src/config/app-env';
import type { LockedRuntimeConfig } from '../../src/config/locked-runtime';
import { AdminUsersService } from '../../src/modules/admin/admin-users.service';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { AddressesService } from '../../src/modules/users/addresses.service';
import { KycService } from '../../src/modules/users/kyc.service';
import { UsersService } from '../../src/modules/users/users.service';
import type { WechatMiniClient } from '../../src/modules/users/wechat-mini.client';
import { Stage1Db } from './stage1-db';

export const UNIT_PRICE_FEN = 100_000;

export class MutableClock {
  current = new Date('2026-11-13T00:00:00.000Z');

  async now(): Promise<Date> {
    return this.current;
  }

  instant(unixMs: number): Date {
    return new Date(unixMs);
  }
}

export class FakeWechat {
  readonly logins = new Map<string, { openid: string; unionid: string | null }>();
  readonly phones = new Map<string, string>();
  calls = 0;

  async exchangeLoginCode(code: string): Promise<{ openid: string; unionid: string | null }> {
    this.calls += 1;
    const found = this.logins.get(code);
    if (!found) {
      throw new UnauthorizedException('微信登录失败');
    }
    return { ...found };
  }

  async exchangePhoneCode(code: string): Promise<string> {
    this.calls += 1;
    const phone = this.phones.get(code);
    if (!phone) {
      throw new BadRequestException('微信手机号获取失败');
    }
    return phone;
  }
}

export function stage1Env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    nodeEnv: 'test',
    port: 3000,
    databaseUrl: 'mysql://u:p@127.0.0.1:3306/db',
    redisUrl: 'redis://127.0.0.1:6379',
    allowClockOverride: false,
    allowPreviewAuth: false,
    adminJwtSecret: 'test-secret-admin',
    miniProgramTokenSecret: 'test-secret-mini',
    adminBootstrapUsername: null,
    adminBootstrapPassword: null,
    adminBootstrapDisplayName: null,
    wechatPayNotifyUrl: null,
    wechatMiniAppId: 'wx-test-app',
    wechatMiniAppSecret: 'test-mini-secret',
    marketingManagerMarketThresholdDefault: '2000000',
    locked: lockedConfig(UNIT_PRICE_FEN),
    ...overrides,
  };
}

export function lockedConfig(startupZoneUnitPriceFen: number): LockedRuntimeConfig {
  return Object.freeze({
    startupZoneUnitPriceFen,
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
      Object.freeze({ positionCode: 'senior_manager', poolBps: 600 }),
      Object.freeze({ positionCode: 'director', poolBps: 500 }),
      Object.freeze({ positionCode: 'senior_director', poolBps: 400 }),
      Object.freeze({ positionCode: 'chief', poolBps: 300 }),
    ]),
    redPacketDailyAccrualBps: 0,
    redPacketRoundPayThresholdFen: 0,
    redPacketRoundClaimCapFen: 0,
    cofounderDividendRatioBps: 0,
    cofounderStartupDividendRatioBps: 0,
    cofounderMallDividendRatioBps: 0,
    studioStartupSubsidyRatioBps: 0,
    studioMallSubsidyRatioBps: 0,
    operationsTeamDividendRatioBps: 0,
    withdrawalFeeFen: 0,
  });
}

export function buildStage1(env: AppEnv = stage1Env()) {
  const db = new Stage1Db();
  const clock = new MutableClock();
  const tokens = new MiniProgramTokenService(clock as unknown as ClockService, env);
  const wechat = new FakeWechat();
  const prisma = db as unknown as PrismaService;
  const users = new UsersService(
    prisma,
    clock as unknown as ClockService,
    tokens,
    wechat as unknown as WechatMiniClient,
    env,
  );
  const kyc = new KycService(prisma, clock as unknown as ClockService);
  const addresses = new AddressesService(prisma, clock as unknown as ClockService);
  const catalog = new CatalogService(prisma, clock as unknown as ClockService, users, env.locked);
  const adminUsers = new AdminUsersService(prisma, clock as unknown as ClockService, kyc);
  return { db, clock, env, tokens, wechat, users, kyc, addresses, catalog, adminUsers };
}
