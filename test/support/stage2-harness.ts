import { ConflictException } from '@nestjs/common';
import type { ClockService } from '../../src/common/clock/clock.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { OrderPaymentSettler } from '../../src/modules/orders/order-payment.settler';
import {
  PendingSettlementHook,
  type OrderPaidEvent,
} from '../../src/modules/orders/order-paid.hook';
import { OrdersService } from '../../src/modules/orders/orders.service';
import type { WechatPayGateway } from '../../src/modules/payments/wechat-pay.gateway';
import type {
  WechatPayCredentials,
  WechatPaySettingsService,
} from '../../src/modules/payments/wechat-pay-settings.service';
import { WechatPayService } from '../../src/modules/payments/wechat-pay.service';
import { TreesService } from '../../src/modules/rewards/trees/trees.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { Stage1Db } from './stage1-db';
import { buildStage1, lockedConfig, stage1Env } from './stage1-harness';

export class RecordingHook extends PendingSettlementHook {
  readonly events: OrderPaidEvent[] = [];
  fail = false;

  override async afterOrderPaid(event: OrderPaidEvent): Promise<void> {
    if (this.fail) {
      throw new ConflictException('结算钩子失败');
    }
    this.events.push(event);
  }
}

export function buildStage2(unitPriceFen = 1000) {
  const env = stage1Env({ locked: lockedConfig(unitPriceFen) });
  const stage1 = buildStage1(env);
  const prisma = stage1.db as unknown as PrismaService;
  const clock = stage1.clock as unknown as ClockService;
  const wallet = new WalletService(prisma, clock);
  const trees = new TreesService();
  const hook = new RecordingHook();
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
  const gateway = {
    createJsapiTransaction: jest.fn(),
    verifyAndDecrypt: jest.fn(),
  };
  const wechatPay = new WechatPayService(
    prisma,
    clock,
    paySettings as unknown as WechatPaySettingsService,
    gateway as unknown as WechatPayGateway,
    env,
    settlement,
  );
  const orders = new OrdersService(prisma, clock, wallet, trees, settlement, wechatPay, env.locked);
  return {
    ...stage1,
    env,
    wallet,
    trees,
    hook,
    settlement,
    wechatPay,
    orders,
    gateway,
    paySettings,
  };
}

export type Stage2 = ReturnType<typeof buildStage2>;

export async function boot(stage: Stage2): Promise<bigint> {
  await stage.users.onModuleInit();
  const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
  if (!root) {
    throw new Error('missing root');
  }
  return root.id;
}

export async function credit(
  stage: Stage2,
  userId: bigint,
  walletType: 'points' | 'withdrawable' | 'consumption',
  amountFen: number,
): Promise<void> {
  await stage.wallet.credit({
    userId,
    walletType,
    amountFen: BigInt(amountFen),
    bizType: 'test_credit',
    bizId: `${walletType}-${userId.toString()}-${amountFen}-${stage.db.walletLedgerEntry.rows.length}`,
  });
}

export function attachInvite(db: Stage1Db, userId: bigint, parentUserId: bigint, now: Date): void {
  const parent = db.inviteTreeNode.rows.find((row) => row.userId === parentUserId);
  const parentPath = parent ? String(parent.path) : `/${parentUserId.toString()}/`;
  const depth = parent ? Number(parent.depth) + 1 : 1;
  db.inviteTreeNode.create({
    data: {
      userId,
      parentUserId,
      depth,
      path: `${parentPath}${userId.toString()}/`,
      joinedAt: now,
    },
  });
}

export function graftMarket(
  db: Stage1Db,
  userId: bigint,
  parentUserId: bigint,
  placedAt: Date,
): void {
  const parent = db.marketTreeNode.rows.find((row) => row.userId === parentUserId);
  if (!parent) {
    throw new Error('missing market parent');
  }
  db.marketTreeNode.create({
    data: {
      userId,
      parentUserId,
      depth: Number(parent.depth) + 1,
      path: `${String(parent.path)}${userId.toString()}/`,
      placedAt,
    },
  });
}

export function marketNode(db: Stage1Db, userId: bigint) {
  return db.marketTreeNode.rows.find((row) => row.userId === userId) ?? null;
}

export function parentChain(db: Stage1Db, userId: bigint): bigint[] {
  const chain: bigint[] = [];
  let current = userId;
  const seen = new Set<string>();
  while (!seen.has(current.toString())) {
    seen.add(current.toString());
    const node = marketNode(db, current);
    if (!node || node.parentUserId === null || node.parentUserId === undefined) {
      break;
    }
    const parentUserId = node.parentUserId as bigint;
    chain.push(parentUserId);
    current = parentUserId;
  }
  return chain;
}

export async function addressOf(stage: Stage2, userId: bigint): Promise<bigint> {
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

export async function loginBuyer(
  stage: Stage2,
  subject: string,
  inviterUserId: bigint | null,
): Promise<bigint> {
  stage.wechat.logins.set(subject, { openid: `openid-${subject}`, unionid: null });
  const session = await stage.users.loginWithMiniProgram(subject);
  if (inviterUserId !== null) {
    const inviter = stage.db.user.rows.find((row) => row.id === inviterUserId);
    const code = inviter?.inviteCode;
    if (typeof code === 'string' && code.length > 0) {
      await stage.users.bindInviter(session.user.id, code);
    } else {
      attachInvite(stage.db, session.user.id, inviterUserId, stage.clock.current);
    }
  }
  return session.user.id;
}

export function stockOf(db: Stage1Db, skuId: bigint): number {
  const row = db.skuStock.rows.find((item) => item.skuId === skuId);
  return Number(row?.quantity ?? -1);
}

export function debits(db: Stage1Db, userId: bigint, walletType: string) {
  return db.walletLedgerEntry.rows.filter(
    (row) => row.userId === userId && row.walletType === walletType && row.direction === 'debit',
  );
}
