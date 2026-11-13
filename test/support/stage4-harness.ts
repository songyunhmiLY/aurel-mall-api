import type { ClockService } from '../../src/common/clock/clock.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../src/config/locked-runtime';
import { DueJobRunner } from '../../src/jobs/due-job.runner';
import { OrderPaymentSettler } from '../../src/modules/orders/order-payment.settler';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { PaymentSettlementHook } from '../../src/modules/orders/payment-settlement.hook';
import type { WechatPayGateway } from '../../src/modules/payments/wechat-pay.gateway';
import type {
  WechatPayCredentials,
  WechatPaySettingsService,
} from '../../src/modules/payments/wechat-pay-settings.service';
import { WechatPayService } from '../../src/modules/payments/wechat-pay.service';
import { AwardAdminService } from '../../src/modules/rewards/admin/award-admin.service';
import { NetworkAdminService } from '../../src/modules/rewards/admin/network-admin.service';
import { AwardCreditService } from '../../src/modules/rewards/award-credit.service';
import { AwardService } from '../../src/modules/rewards/award.service';
import { FilingQueryService } from '../../src/modules/rewards/filing/filing-query.service';
import { FilingService } from '../../src/modules/rewards/filing/filing.service';
import { MarketPerformanceService } from '../../src/modules/rewards/market-performance.service';
import { PaymentSettlementService } from '../../src/modules/rewards/payment-settlement.service';
import { PositionsService } from '../../src/modules/rewards/positions/positions.service';
import { TeamService } from '../../src/modules/rewards/team/team.service';
import { TreesService } from '../../src/modules/rewards/trees/trees.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { WalletAdminService } from '../../src/modules/wallet/wallet-admin.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { lockedConfig, stage1Env, buildStage1 } from './stage1-harness';

export function stage4Locked(unitPriceFen = 100_000): LockedRuntimeConfig {
  return Object.freeze({
    ...lockedConfig(unitPriceFen),
    filingWithdrawalRatioBps: 2000,
    filingDailyCheckTime: '00:01',
    startupSalesRatioBps: 500,
    startupPointRatioBps: 200,
    mallSalesRatioBps: 500,
    mallPointRatioBps: 200,
  });
}

export function buildStage4(locked: LockedRuntimeConfig = stage4Locked(), threshold = '2000000') {
  const env = stage1Env({
    locked,
    marketingManagerMarketThresholdDefault: threshold,
  });
  const stage1 = buildStage1(env);
  const prisma = stage1.db as unknown as PrismaService;
  const clock = stage1.clock as unknown as ClockService;
  const wallet = new WalletService(prisma, clock);
  const trees = new TreesService();
  const credits = new AwardCreditService(wallet);
  const filing = new FilingService(prisma, clock, locked, credits);
  const awards = new AwardService(locked, credits);
  const paid = new PaymentSettlementService(filing, awards);
  const hook = new PaymentSettlementHook(paid);
  const settlement = new OrderPaymentSettler(wallet, trees, hook);
  const paySettings: {
    credentials: WechatPayCredentials | null;
    readCredentials(): Promise<WechatPayCredentials | null>;
    isConfigured(): Promise<boolean>;
  } = {
    credentials: null,
    async readCredentials() {
      return this.credentials;
    },
    async isConfigured() {
      return this.credentials !== null;
    },
  };
  const gateway = { createJsapiTransaction: jest.fn(), verifyAndDecrypt: jest.fn() };
  const wechatPay = new WechatPayService(
    prisma,
    clock,
    paySettings as unknown as WechatPaySettingsService,
    gateway as unknown as WechatPayGateway,
    env,
    settlement,
  );
  const orders = new OrdersService(prisma, clock, wallet, trees, settlement, wechatPay, locked);
  const settings = new SettingsService(prisma, clock, env);
  const performance = new MarketPerformanceService(prisma);
  const positions = new PositionsService(prisma, clock, locked, settings, performance, credits);
  const team = new TeamService(prisma, clock, performance);
  const jobs = new DueJobRunner(filing, positions);
  const network = new NetworkAdminService(prisma, performance);
  const filingQuery = new FilingQueryService(prisma);
  const awardAdmin = new AwardAdminService(prisma);
  const walletAdmin = new WalletAdminService(prisma, wallet);
  return {
    ...stage1,
    env,
    locked,
    wallet,
    trees,
    orders,
    filing,
    awards,
    paid,
    settings,
    positions,
    team,
    jobs,
    network,
    filingQuery,
    awardAdmin,
    walletAdmin,
    performance,
    wechatPay,
  };
}

export type Stage4 = ReturnType<typeof buildStage4>;
