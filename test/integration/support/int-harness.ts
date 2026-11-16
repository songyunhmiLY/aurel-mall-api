/**
 * 集成测试装配：真实 MySQL（PrismaService）+ 真实业务服务。
 *
 * 与单元测试（stage1/2/4 内存库）的区别：
 * - 走真实 PrismaClient，验证 Schema 约束、唯一索引、行锁和 $transaction 隔离；
 * - 服务装配顺序与 stage4 一致，另加提现 / 退款 / 银行卡 / KYC；
 * - 微信网关仍是测试替身（不连真实微信）；
 * - 时钟是可变的固定时钟（实现 ClockService 全部用到的方法）。
 */

import type { PrismaService } from '../../../src/common/prisma/prisma.service';
import type { ClockService } from '../../../src/common/clock/clock.service';
import type { ClockDescription, ResolvedClock } from '../../../src/common/clock/clock.service';
import {
  BUSINESS_TIMEZONE,
  shanghaiBizDate,
  startOfShanghaiDay,
  startOfShanghaiMonth,
} from '../../../src/common/clock/shanghai-calendar';
import { PrismaService as RealPrismaService } from '../../../src/common/prisma/prisma.service';
import { MiniProgramTokenService } from '../../../src/common/auth/mini-program-token.service';
import type { AppEnv } from '../../../src/config/app-env';
import { AdminUsersService } from '../../../src/modules/admin/admin-users.service';
import { CatalogService } from '../../../src/modules/catalog/catalog.service';
import {
  PRODUCT_ZONE_MALL,
  PRODUCT_ZONE_STARTUP,
} from '../../../src/modules/catalog/catalog.constants';
import { OrderPaymentSettler } from '../../../src/modules/orders/order-payment.settler';
import { OrdersService } from '../../../src/modules/orders/orders.service';
import { PaymentSettlementHook } from '../../../src/modules/orders/payment-settlement.hook';
import { SettlementCompensationService } from '../../../src/modules/orders/settlement-compensation.service';
import type { WechatPayGateway } from '../../../src/modules/payments/wechat-pay.gateway';
import type {
  WechatPayCredentials,
  WechatPaySettingsService,
} from '../../../src/modules/payments/wechat-pay-settings.service';
import { WechatPayService } from '../../../src/modules/payments/wechat-pay.service';
import { RefundsService } from '../../../src/modules/orders/refunds.service';
import { CofounderDividendService } from '../../../src/modules/cofounder/cofounder-dividend.service';
import { CofounderPoolService } from '../../../src/modules/cofounder/cofounder-pool.service';
import { CofounderSettingsService } from '../../../src/modules/cofounder/cofounder-settings.service';
import { OpsTeamDividendService } from '../../../src/modules/ops-team/ops-team-dividend.service';
import { OpsTeamEnrollmentService } from '../../../src/modules/ops-team/ops-team-enrollment.service';
import { StudioSubsidyService } from '../../../src/modules/studio/studio-subsidy.service';
import { AwardCreditService } from '../../../src/modules/rewards/award-credit.service';
import { AwardService } from '../../../src/modules/rewards/award.service';
import { FilingService } from '../../../src/modules/rewards/filing/filing.service';
import { PaymentSettlementService } from '../../../src/modules/rewards/payment-settlement.service';
import { TreesService } from '../../../src/modules/rewards/trees/trees.service';
import { KycService } from '../../../src/modules/users/kyc.service';
import { AddressesService } from '../../../src/modules/users/addresses.service';
import { UsersService } from '../../../src/modules/users/users.service';
import type { WechatMiniClient } from '../../../src/modules/users/wechat-mini.client';
import { ROOT_INVITE_CODE } from '../../../src/modules/users/identity.constants';
import { CashLedgerService } from '../../../src/modules/wallet/cash-ledger.service';
import { BankAccountService } from '../../../src/modules/wallet/bank-account.service';
import { WalletService } from '../../../src/modules/wallet/wallet.service';
import { WithdrawalService } from '../../../src/modules/wallet/withdrawal.service';
import { FakeWechat, lockedConfig, stage1Env } from '../../support/stage1-harness';

/** 可变固定时钟，实现 ClockService 在业务里实际被调用的全部方法。 */
export class IntegrationClock {
  current = new Date('2026-11-14T04:00:00.000Z');

  async now(): Promise<Date> {
    return this.current;
  }

  instant(unixMs: number): Date {
    return new Date(unixMs);
  }

  async startOfDay(instant?: Date): Promise<Date> {
    return startOfShanghaiDay(instant ?? this.current);
  }

  async startOfMonth(instant?: Date): Promise<Date> {
    return startOfShanghaiMonth(instant ?? this.current);
  }

  async bizDate(instant?: Date): Promise<string> {
    return shanghaiBizDate(instant ?? this.current);
  }

  async resolve(): Promise<ResolvedClock> {
    return { now: this.current, realNow: this.current, source: 'real' };
  }

  async describe(): Promise<ClockDescription> {
    return {
      now: this.current.toISOString(),
      realNow: this.current.toISOString(),
      source: 'real',
      timezone: BUSINESS_TIMEZONE,
      startOfDay: startOfShanghaiDay(this.current).toISOString(),
      startOfMonth: startOfShanghaiMonth(this.current).toISOString(),
      bizDate: shanghaiBizDate(this.current),
    };
  }
}

/** 集成环境锁定配置：单价 10 元便于手工推算，比例用官方示例，手续费 1 元。 */
export function integrationLocked() {
  return Object.freeze({
    ...lockedConfig(1000),
    filingWithdrawalRatioBps: 2000,
    startupSalesRatioBps: 500,
    startupPointRatioBps: 200,
    mallSalesRatioBps: 500,
    mallPointRatioBps: 200,
    withdrawalFeeBps: 100,
  });
}

export function buildIntHarness(databaseUrl: string) {
  const locked = integrationLocked();
  const env: AppEnv = stage1Env({ databaseUrl, locked, allowPreviewAuth: true });
  const prisma = new RealPrismaService(env) as unknown as PrismaService;
  const clock = new IntegrationClock() as unknown as ClockService;
  const tokens = new MiniProgramTokenService(clock, env);
  const wechat = new FakeWechat();

  const users = new UsersService(prisma, clock, tokens, wechat as unknown as WechatMiniClient, env);
  const kyc = new KycService(prisma, clock);
  const addresses = new AddressesService(prisma, clock);
  const banks = new BankAccountService(prisma, clock);
  const catalog = new CatalogService(prisma, clock, users, env.locked);
  const adminUsers = new AdminUsersService(prisma, clock, kyc);

  const wallet = new WalletService(prisma, clock);
  const trees = new TreesService();
  const credits = new AwardCreditService(wallet);
  const filing = new FilingService(prisma, clock, env.locked, credits);
  const awards = new AwardService(env.locked, credits);
  const cofounderPool = new CofounderPoolService(prisma);
  const cofounderSettings = new CofounderSettingsService(prisma, clock);
  const cofounderDividend = new CofounderDividendService(
    prisma,
    clock,
    env.locked,
    credits,
    cofounderPool,
    cofounderSettings,
  );
  const studioSubsidy = new StudioSubsidyService(env.locked, credits);
  const opsTeamEnrollment = new OpsTeamEnrollmentService(prisma, clock);
  const opsTeamDividend = new OpsTeamDividendService(env.locked, credits, opsTeamEnrollment);
  const paid = new PaymentSettlementService(
    filing,
    awards,
    cofounderDividend,
    studioSubsidy,
    opsTeamDividend,
  );
  const hook = new PaymentSettlementHook(paid);
  const cash = new CashLedgerService();
  const settlement = new OrderPaymentSettler(wallet, trees, hook, cash);

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
  const gateway = {
    createJsapiTransaction: jest.fn(),
    verifyAndDecrypt: jest.fn(),
    createDomesticRefund: jest.fn(),
  };
  const wechatPay = new WechatPayService(
    prisma,
    clock,
    paySettings as unknown as WechatPaySettingsService,
    gateway as unknown as WechatPayGateway,
    env,
    settlement,
    undefined,
    cash,
  );
  const orders = new OrdersService(prisma, clock, wallet, trees, settlement, wechatPay, env.locked, env);
  const compensations = new SettlementCompensationService(
    prisma,
    clock,
    wallet,
    settlement,
    cash,
    paySettings as unknown as WechatPaySettingsService,
    gateway as unknown as WechatPayGateway,
  );
  const withdrawals = new WithdrawalService(
    prisma,
    clock,
    wallet,
    kyc,
    cash,
    env.locked as Pick<typeof env.locked, 'withdrawalFeeBps'>,
  );
  const refunds = new RefundsService(
    prisma,
    clock,
    wallet,
    cash,
    paySettings as unknown as WechatPaySettingsService,
    gateway as unknown as WechatPayGateway,
  );

  return {
    env,
    locked,
    prisma,
    clock,
    wechat,
    users,
    kyc,
    addresses,
    banks,
    catalog,
    adminUsers,
    wallet,
    trees,
    credits,
    filing,
    awards,
    paid,
    hook,
    cash,
    settlement,
    wechatPay,
    orders,
    compensations,
    withdrawals,
    refunds,
    gateway,
    paySettings,
  };
}

export type IntHarness = ReturnType<typeof buildIntHarness>;

/** 清空业务表。迁移表保留。外键约束临时关闭。 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = (await prisma.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
    "SELECT TABLE_NAME AS TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND TABLE_NAME NOT LIKE '\\_prisma\\_%'",
  )) as Array<{ TABLE_NAME: string }>;
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=0');
  for (const row of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${row.TABLE_NAME}\``);
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=1');
}

/** 连接并初始化官方根账户。幂等，可在每个用例前重复调用。 */
export async function bootInt(stage: IntHarness): Promise<bigint> {
  await stage.prisma.$connect();
  await stage.users.onModuleInit();
  const root = await stage.prisma.user.findUnique({ where: { inviteCode: ROOT_INVITE_CODE } });
  if (!root) {
    throw new Error('官方根账户初始化失败');
  }
  return root.id;
}

let creditSeq = 0;

export async function credit(
  stage: IntHarness,
  userId: bigint,
  walletType: 'points' | 'withdrawable' | 'consumption',
  amountFen: number,
): Promise<void> {
  creditSeq += 1;
  await stage.wallet.credit({
    userId,
    walletType,
    amountFen: BigInt(amountFen),
    bizType: 'test_credit',
    bizId: `it-${walletType}-${userId.toString()}-${creditSeq}`,
  });
}

export async function loginBuyer(
  stage: IntHarness,
  subject: string,
  inviterUserId: bigint,
): Promise<bigint> {
  stage.wechat.logins.set(subject, { openid: `openid-${subject}`, unionid: null });
  const session = await stage.users.loginWithMiniProgram(subject);
  const inviter = await stage.prisma.user.findUnique({ where: { id: inviterUserId } });
  if (!inviter?.inviteCode) {
    throw new Error('邀请人缺少邀请码');
  }
  await stage.users.bindInviter(session.user.id, inviter.inviteCode);
  return session.user.id;
}

export async function addressOf(stage: IntHarness, userId: bigint): Promise<bigint> {
  const address = await stage.addresses.create(userId, {
    contactName: '张三',
    contactPhone: '13800138000',
    province: '浙江省',
    city: '杭州市',
    district: '西湖区',
    detail: '文三路 1 号',
    isDefault: true,
  });
  return address.id;
}

export async function startupProduct(
  stage: IntHarness,
  name: string,
  stock: number,
): Promise<{ productId: bigint; skuId: bigint }> {
  const created = await stage.catalog.create({
    zone: PRODUCT_ZONE_STARTUP,
    name,
    freightFen: 0,
    stockQuantity: stock,
    status: 'on',
  });
  return { productId: created.product.id, skuId: created.product.skuId };
}

export async function mallProduct(
  stage: IntHarness,
  name: string,
  priceFen: number,
  pvFen: number,
  stock: number,
): Promise<{ productId: bigint; skuId: bigint }> {
  const created = await stage.catalog.create({
    zone: PRODUCT_ZONE_MALL,
    name,
    freightFen: 0,
    priceFen,
    pvFen,
    stockQuantity: stock,
    status: 'on',
  });
  return { productId: created.product.id, skuId: created.product.skuId };
}

export async function balancesOf(stage: IntHarness, userId: bigint) {
  const result = await stage.wallet.getBalances(userId);
  return result;
}
