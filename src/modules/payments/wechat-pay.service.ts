import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { signJsapiPay } from './wechat-pay-crypto';
import {
  WechatPayGateway,
  type VerifiedWechatTrade,
  type WechatNotifyHeaders,
} from './wechat-pay.gateway';
import { WechatPaySettingsService } from './wechat-pay-settings.service';
import { assertPaymentStatus, nextPaymentStatus } from './wechat-pay-state';
import { WECHAT_PAY_CHANNEL, activePaymentSlot } from './wechat-pay.constants';
import { OrderPaymentSettler } from '../orders/order-payment.settler';

const MYSQL_SIGNED_BIGINT_MAX = 9223372036854775807n;
const ORDER_PENDING_PAYMENT = 'pending_payment';
const ORDER_PAID = 'paid';
const ORDER_SHIPPED = 'shipped';

export interface CreateWechatPrepayInput {
  orderId: string;
  appId?: string;
  openid?: string;
  description?: string;
}

export interface WechatPrepayView {
  mode: 'sandbox' | 'live';
  payNo: string;
  orderId: string;
  amountFen: number;
  status: string;
  appId: string | null;
  timeStamp: string | null;
  nonceStr: string | null;
  package: string | null;
  signType: 'RSA' | null;
  paySign: string | null;
}

export interface WechatPaymentResult {
  payNo: string;
  status: string;
  orderId: string;
  amountFen: number;
  orderStatus: string | null;
  succeededAt: string | null;
}

interface ApplyTradeInput {
  payNo: string;
  tradeState: string;
  transactionId: string | null;
  amountFen: number | null;
  mchId: string | null;
  expectedMchId: string | null;
  requireTransactionId: boolean;
}

/**
 * 微信支付下单与回调状态机。
 * 商户资料未配齐时走模拟成功或模拟失败，配齐后只接受验签回调。
 * 成功或失败后交给订单结算：扣已冻结的账户份额，或把冻结还回去。
 */
@Injectable()
export class WechatPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly settings: WechatPaySettingsService,
    private readonly gateway: WechatPayGateway,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional()
    @Inject(forwardRef(() => OrderPaymentSettler))
    private readonly settler?: OrderPaymentSettler,
  ) {}

  async createPrepay(input: CreateWechatPrepayInput): Promise<WechatPrepayView> {
    const orderId = parseOrderId(input.orderId);
    const credentials = await this.settings.readCredentials();
    const now = await this.clock.now();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (order.status === ORDER_PAID) {
      throw new ConflictException('订单已支付');
    }
    if (order.status !== ORDER_PENDING_PAYMENT) {
      throw new ConflictException('订单不在待支付状态');
    }
    const chargeFen = resolveWechatChargeFen(order);
    if (!Number.isInteger(chargeFen) || chargeFen < 0) {
      throw new BadRequestException('订单应付金额无效');
    }
    if (chargeFen === 0) {
      throw new BadRequestException('订单尚未确定支付拆分');
    }
    const payment = await this.ensurePendingPayment(order.id, chargeFen, now);
    if (!credentials) {
      return {
        mode: 'sandbox',
        payNo: payment.payNo,
        orderId: order.id.toString(),
        amountFen: payment.amountFen,
        status: payment.status,
        appId: null,
        timeStamp: null,
        nonceStr: null,
        package: null,
        signType: null,
        paySign: null,
      };
    }
    const appId = input.appId?.trim() ?? '';
    const openid = input.openid?.trim() ?? '';
    if (!appId || !openid) {
      throw new BadRequestException('微信支付下单需要 appId 和 openid');
    }
    const notifyUrl = this.env.wechatPayNotifyUrl;
    if (!notifyUrl) {
      throw new BadRequestException('未配置 WECHAT_PAY_NOTIFY_URL，无法向微信支付下单');
    }
    let prepayId = payment.prepayId;
    if (!prepayId) {
      const description = (input.description?.trim() || `订单${order.orderNo}`).slice(0, 127);
      const created = await this.gateway.createJsapiTransaction({
        merchantId: credentials.merchantId,
        privateKeyPem: credentials.privateKeyPem,
        certificateSerial: credentials.serialNumber,
        appId,
        description,
        outTradeNo: payment.payNo,
        notifyUrl,
        amountFen: payment.amountFen,
        openid,
      });
      prepayId = created.prepayId;
      const updatedAt = await this.clock.now();
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { prepayId, updatedAt },
      });
    }
    const signedAt = await this.clock.now();
    const timeStamp = Math.floor(signedAt.getTime() / 1000).toString();
    const nonceStr = randomBytes(16).toString('hex');
    const paySign = signJsapiPay({
      appId,
      timestamp: timeStamp,
      nonce: nonceStr,
      prepayId,
      privateKeyPem: credentials.privateKeyPem,
    });
    return {
      mode: 'live',
      payNo: payment.payNo,
      orderId: order.id.toString(),
      amountFen: payment.amountFen,
      status: 'pending',
      appId,
      timeStamp,
      nonceStr,
      package: `prepay_id=${prepayId}`,
      signType: 'RSA',
      paySign,
    };
  }

  async simulateSuccess(payNo: string): Promise<WechatPaymentResult> {
    if (await this.settings.isConfigured()) {
      throw new ForbiddenException('微信支付已配置，不能使用模拟成功');
    }
    return this.applyTrade({
      payNo,
      tradeState: 'SUCCESS',
      transactionId: null,
      amountFen: null,
      mchId: null,
      expectedMchId: null,
      requireTransactionId: false,
    });
  }

  async simulateFailure(payNo: string): Promise<WechatPaymentResult> {
    if (await this.settings.isConfigured()) {
      throw new ForbiddenException('微信支付已配置，不能使用模拟失败');
    }
    return this.applyTrade({
      payNo,
      tradeState: 'PAYERROR',
      transactionId: null,
      amountFen: null,
      mchId: null,
      expectedMchId: null,
      requireTransactionId: false,
    });
  }

  async handleNotify(rawBody: string, headers: WechatNotifyHeaders): Promise<void> {
    const credentials = await this.settings.readCredentials();
    if (!credentials) {
      throw new BadRequestException('微信支付尚未配置');
    }
    const trade = await this.gateway.verifyAndDecrypt(credentials, rawBody, headers);
    await this.applyVerifiedTrade(trade, credentials.merchantId);
  }

  private async applyVerifiedTrade(
    trade: VerifiedWechatTrade,
    expectedMchId: string,
  ): Promise<void> {
    await this.applyTrade({
      payNo: trade.outTradeNo,
      tradeState: trade.tradeState,
      transactionId: trade.transactionId || null,
      amountFen: trade.amountFen,
      mchId: trade.mchId,
      expectedMchId,
      requireTransactionId: true,
    });
  }

  private async ensurePendingPayment(
    orderId: bigint,
    amountFen: number,
    now: Date,
  ): Promise<{
    id: bigint;
    payNo: string;
    amountFen: number;
    status: string;
    prepayId: string | null;
  }> {
    const existing = await this.prisma.payment.findFirst({
      where: { orderId, channel: WECHAT_PAY_CHANNEL, status: 'pending' },
      orderBy: { id: 'asc' },
    });
    if (existing) {
      if (existing.amountFen !== amountFen) {
        throw new ConflictException('存在金额不一致的待支付单');
      }
      return existing;
    }
    try {
      return await this.prisma.payment.create({
        data: {
          orderId,
          payNo: createPayNo(now),
          channel: WECHAT_PAY_CHANNEL,
          amountFen,
          status: 'pending',
          activeSlot: activePaymentSlot(orderId),
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const raced = await this.prisma.payment.findFirst({
        where: { orderId, channel: WECHAT_PAY_CHANNEL, status: 'pending' },
        orderBy: { id: 'asc' },
      });
      if (!raced) {
        throw error;
      }
      return raced;
    }
  }

  private async applyTrade(input: ApplyTradeInput): Promise<WechatPaymentResult> {
    const now = await this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const payment = await lockPayment(tx, input.payNo);
      if (!payment || payment.channel !== WECHAT_PAY_CHANNEL) {
        throw new NotFoundException('支付单不存在');
      }
      if (input.mchId && input.expectedMchId && input.mchId !== input.expectedMchId) {
        throw new BadRequestException('微信支付商户号不一致');
      }
      const amountFen = normalizeAmountFen(payment.amountFen);
      if (input.amountFen !== null && input.amountFen !== amountFen) {
        throw new BadRequestException('支付金额不一致');
      }
      const succeededAt = normalizeInstant(this.clock, payment.succeededAt);
      const current = assertPaymentStatus(payment.status);
      const next = nextPaymentStatus(current, input.tradeState);
      if (
        next === 'success' &&
        current !== 'success' &&
        input.requireTransactionId &&
        !input.transactionId
      ) {
        throw new BadRequestException('微信支付成功回调缺少 transaction_id');
      }
      const order = await lockOrder(tx, payment.orderId);
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
      if (next === current) {
        return toPaymentResult({ ...payment, amountFen, succeededAt }, order.status);
      }
      const becameSuccess = next === 'success';
      const becameFailed = next === 'failed' && current === 'pending';
      if (
        becameSuccess &&
        order.status !== ORDER_PENDING_PAYMENT &&
        order.status !== ORDER_PAID &&
        order.status !== ORDER_SHIPPED
      ) {
        throw new ConflictException('订单不在待支付状态');
      }
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: next,
          updatedAt: now,
          activeSlot: null,
          ...(becameSuccess ? { succeededAt: now } : {}),
          ...(becameSuccess && input.transactionId ? { channelTradeNo: input.transactionId } : {}),
        },
      });
      let orderStatus = order.status;
      if (becameSuccess && order.status === ORDER_PENDING_PAYMENT) {
        if (this.settler) {
          orderStatus = await this.settler.settleWechatSuccess(tx, order.id, now);
        } else {
          await tx.order.update({
            where: { id: order.id },
            data: { status: ORDER_PAID, paidAt: now, updatedAt: now },
          });
          orderStatus = ORDER_PAID;
        }
      } else if (becameFailed && this.settler) {
        await this.settler.releaseWechatFailure(tx, order.id, now);
      }
      return toPaymentResult(
        {
          payNo: payment.payNo,
          status: next,
          orderId: payment.orderId,
          amountFen,
          succeededAt: becameSuccess ? now : succeededAt,
        },
        orderStatus,
      );
    });
  }
}

interface PaymentLockRow {
  id: bigint | number | string;
  orderId: bigint | number | string;
  payNo: string;
  channel: string;
  amountFen: number | string;
  status: string;
  succeededAt: Date | string | null;
}

interface LockedPayment {
  id: bigint;
  orderId: bigint;
  payNo: string;
  channel: string;
  amountFen: number | string;
  status: string;
  succeededAt: Date | string | null;
}

interface LockedOrder {
  id: bigint;
  status: string;
}

async function lockPayment(
  tx: Prisma.TransactionClient,
  payNo: string,
): Promise<LockedPayment | null> {
  const rows = await tx.$queryRaw<PaymentLockRow[]>`
    SELECT
      id,
      order_id AS orderId,
      pay_no AS payNo,
      channel,
      amount_fen AS amountFen,
      status,
      succeeded_at AS succeededAt
    FROM payments
    WHERE pay_no = ${payNo}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { ...row, id: asBigInt(row.id), orderId: asBigInt(row.orderId) };
}

async function lockOrder(
  tx: Prisma.TransactionClient,
  orderId: bigint,
): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<Array<{ id: bigint | number | string; status: string }>>`
    SELECT id, status
    FROM orders
    WHERE id = ${orderId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { id: asBigInt(row.id), status: row.status };
}

function asBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function toPaymentResult(
  payment: {
    payNo: string;
    status: string;
    orderId: bigint;
    amountFen: number;
    succeededAt: Date | null;
  },
  orderStatus: string | null,
): WechatPaymentResult {
  return {
    payNo: payment.payNo,
    status: payment.status,
    orderId: payment.orderId.toString(),
    amountFen: payment.amountFen,
    orderStatus,
    succeededAt: payment.succeededAt ? payment.succeededAt.toISOString() : null,
  };
}

function createPayNo(now: Date): string {
  const time = now.getTime().toString(36).toUpperCase();
  const rand = randomBytes(8).toString('hex').toUpperCase();
  return `W${time}${rand}`.slice(0, 32);
}

function normalizeInstant(clock: ClockService, value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const unixMs = Date.parse(value);
  if (Number.isNaN(unixMs)) {
    return null;
  }
  return clock.instant(unixMs);
}

function normalizeAmountFen(value: number | string): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(amount)) {
    throw new BadRequestException('支付金额无效');
  }
  return amount;
}

function resolveWechatChargeFen(order: { payAmountFen: number; wechatFen?: number }): number {
  if (typeof order.wechatFen === 'number') {
    return order.wechatFen;
  }
  return order.payAmountFen;
}

function parseOrderId(value: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    throw new BadRequestException('订单 ID 无效');
  }
  const id = BigInt(value);
  if (id <= 0n || id > MYSQL_SIGNED_BIGINT_MAX) {
    throw new BadRequestException('订单 ID 无效');
  }
  return id;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
