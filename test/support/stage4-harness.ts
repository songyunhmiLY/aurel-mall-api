import type { ClockService } from '../../src/common/clock/clock.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../src/config/locked-runtime';
import { DueJobRunner } from '../../src/jobs/due-job.runner';
import { CofounderAdminService } from '../../src/modules/cofounder/cofounder-admin.service';
import { CofounderDividendService } from '../../src/modules/cofounder/cofounder-dividend.service';
import { CofounderEnrollmentService } from '../../src/modules/cofounder/cofounder-enrollment.service';
import { CofounderPayService } from '../../src/modules/cofounder/cofounder-pay.service';
import { CofounderPoolService } from '../../src/modules/cofounder/cofounder-pool.service';
import { CofounderReviewService } from '../../src/modules/cofounder/cofounder-review.service';
import { CofounderSettingsService } from '../../src/modules/cofounder/cofounder-settings.service';
import { StudioEnrollmentService } from '../../src/modules/studio/studio-enrollment.service';
import { StudioSettingsService } from '../../src/modules/studio/studio-settings.service';
import { StudioSubsidyService } from '../../src/modules/studio/studio-subsidy.service';
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
import { RedPacketAdminService } from '../../src/modules/rewards/red-packet/red-packet-admin.service';
import { RedPacketService } from '../../src/modules/rewards/red-packet/red-packet.service';
import { TeamService } from '../../src/modules/rewards/team/team.service';
import { TreesService } from '../../src/modules/rewards/trees/trees.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { CashLedgerService } from '../../src/modules/wallet/cash-ledger.service';
import { DisplayNameService } from '../../src/modules/wallet/display-name.service';
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
  const cofounderPool = new CofounderPoolService(prisma);
  const cofounderSettings = new CofounderSettingsService(prisma, clock);
  const cofounderDividend = new CofounderDividendService(
    prisma,
    clock,
    locked,
    credits,
    cofounderPool,
    cofounderSettings,
  );
  const studioSubsidy = new StudioSubsidyService(locked, credits);
  const paid = new PaymentSettlementService(filing, awards, cofounderDividend, studioSubsidy);
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
  const cash = new CashLedgerService();
  const cofounderEnrollment = new CofounderEnrollmentService(
    prisma,
    clock,
    cofounderPool,
    cofounderSettings,
    cash,
  );
  wechatPay.bindActivationSettler(cofounderEnrollment);
  const cofounderPay = new CofounderPayService(
    prisma,
    clock,
    cofounderPool,
    cofounderEnrollment,
    wechatPay,
  );
  const cofounderReview = new CofounderReviewService(prisma);
  const cofounderAdmin = new CofounderAdminService(
    prisma,
    clock,
    cofounderSettings,
    cofounderPool,
    cofounderDividend,
    cofounderEnrollment,
    cofounderReview,
    locked,
  );
  const studioSettings = new StudioSettingsService(prisma, clock);
  const studioEnrollment = new StudioEnrollmentService(prisma, clock);
  const displayNames = new DisplayNameService(prisma, clock, wallet);
  const settings = new SettingsService(prisma, clock, env);
  const performance = new MarketPerformanceService(prisma);
  const positions = new PositionsService(prisma, clock, locked, settings, performance, credits);
  const team = new TeamService(prisma, clock, performance);
  const redPackets = new RedPacketService(prisma, clock, locked, credits);
  const welfareAdmin = new RedPacketAdminService(prisma, clock, redPackets);
  const jobs = new DueJobRunner(filing, positions, redPackets, cofounderDividend);
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
    redPackets,
    welfareAdmin,
    jobs,
    network,
    filingQuery,
    awardAdmin,
    walletAdmin,
    performance,
    wechatPay,
    paySettings,
    gateway,
    cofounderPool,
    cofounderSettings,
    cofounderDividend,
    cofounderEnrollment,
    cofounderPay,
    cofounderReview,
    cofounderAdmin,
    studioSubsidy,
    studioSettings,
    studioEnrollment,
    displayNames,
    cash,
  };
}

export type Stage4 = ReturnType<typeof buildStage4>;
