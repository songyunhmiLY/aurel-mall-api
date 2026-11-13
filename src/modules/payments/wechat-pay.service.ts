import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  InternalServerErrorException,
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
import {
  PAYMENT_PURPOSE_COFOUNDER,
  PAYMENT_PURPOSE_ORDER,
  WECHAT_PAY_CHANNEL,
  activeCofounderSlot,
  activePaymentSlot,
} from './wechat-pay.constants';
import { OrderPaymentSettler } from '../orders/order-payment.settler';
import { CofounderActivationSettler } from '../cofounder/cofounder-activation.settler';
import { IDENTITY_PROVIDERS } from '../users/identity.constants';

const MYSQL_SIGNED_BIGINT_MAX = 9223372036854775807n;
const ORDER_PENDING_PAYMENT = 'pending_payment';
const ORDER_PAID = 'paid';
const ORDER_SHIPPED = 'shipped';

export interface CreateWechatPrepayInput {
  orderId: string;
  /**
   * 订单支付传入的当前用户。
   * 正式下单时，缺的 appId / openid 用这个用户已有的 wechat_mini 身份补上，自带的必须和该身份一致。
   */
  userId?: bigint;
  appId?: string;
  openid?: string;
  description?: string;
}

export interface WechatPrepayView {
  mode: 'sandbox' | 'live';
  purpose: string;
  payNo: string;
  orderId: string | null;
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
  orderId: string | null;
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
 * 订单支付会带上当前用户。正式下单缺的 appId、openid 取自该用户的 wechat_mini 身份。
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
    @Optional()
    @Inject(forwardRef(() => CofounderActivationSettler))
    activationSettler?: CofounderActivationSettler,
  ) {
    this.activationSettler = activationSettler;
  }

  private activationSettler?: CofounderActivationSettler;

  /** 测试手工装配。Nest 由构造函数注入。 */
  bindActivationSettler(settler: CofounderActivationSettler): void {
    this.activationSettler = settler;
  }

  async createPrepay(input: CreateWechatPrepayInput): Promise<WechatPrepayView> {
    const orderId = parseOrderId(input.orderId);
    const credentials = await this.settings.readCredentials();
    const now = await this.clock.now();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (input.userId !== undefined && order.userId !== input.userId) {
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
        purpose: PAYMENT_PURPOSE_ORDER,
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
    const payer =
      input.userId === undefined
        ? requireExplicitPayer(input)
        : await this.payerForUser(input.userId, input);
    const { appId, openid } = payer;
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
      purpose: PAYMENT_PURPOSE_ORDER,
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

  async ensureCofounderPayment(
    tx: Prisma.TransactionClient,
    userId: bigint,
    amountFen: number,
    now: Date,
  ): Promise<{
    id: bigint;
    payNo: string;
    amountFen: number;
    status: string;
    prepayId: string | null;
  }> {
    if (!Number.isInteger(amountFen) || amountFen <= 0) {
      throw new BadRequestException('开通金额不正确');
    }
    const existing = await tx.payment.findFirst({
      where: { userId, purpose: PAYMENT_PURPOSE_COFOUNDER, status: 'pending' },
      orderBy: { id: 'asc' },
    });
    if (existing) {
      if (existing.amountFen !== amountFen) {
        throw new ConflictException('存在金额不一致的待支付单');
      }
      return existing;
    }
    try {
      return await tx.payment.create({
        data: {
          orderId: null,
          purpose: PAYMENT_PURPOSE_COFOUNDER,
          userId,
          payNo: createPayNo(now),
          channel: WECHAT_PAY_CHANNEL,
          amountFen,
          status: 'pending',
          activeSlot: activeCofounderSlot(userId),
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const raced = await tx.payment.findFirst({
        where: { userId, purpose: PAYMENT_PURPOSE_COFOUNDER, status: 'pending' },
        orderBy: { id: 'asc' },
      });
      if (!raced || raced.amountFen !== amountFen) {
        throw new ConflictException('存在金额不一致的待支付单');
      }
      return raced;
    }
  }

  async presentCofounderPrepay(payNo: string, userId: bigint): Promise<WechatPrepayView> {
    const credentials = await this.settings.readCredentials();
    const payment = await this.prisma.payment.findUnique({ where: { payNo } });
    if (!payment || payment.purpose !== PAYMENT_PURPOSE_COFOUNDER || payment.userId !== userId) {
      throw new NotFoundException('支付单不存在');
    }
    if (payment.status === 'success') {
      throw new ConflictException('开通费已支付');
    }
    if (payment.status !== 'pending') {
      throw new ConflictException('支付单不在待支付状态');
    }
    if (!credentials) {
      return {
        mode: 'sandbox',
        purpose: PAYMENT_PURPOSE_COFOUNDER,
        payNo: payment.payNo,
        orderId: null,
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
    const payer = await this.payerForUser(userId, {});
    const notifyUrl = this.env.wechatPayNotifyUrl;
    if (!notifyUrl) {
      throw new BadRequestException('未配置 WECHAT_PAY_NOTIFY_URL，无法向微信支付下单');
    }
    let prepayId = payment.prepayId;
    if (!prepayId) {
      const created = await this.gateway.createJsapiTransaction({
        merchantId: credentials.merchantId,
        privateKeyPem: credentials.privateKeyPem,
        certificateSerial: credentials.serialNumber,
        appId: payer.appId,
        description: '联合创始人开通',
        outTradeNo: payment.payNo,
        notifyUrl,
        amountFen: payment.amountFen,
        openid: payer.openid,
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
      appId: payer.appId,
      timestamp: timeStamp,
      nonce: nonceStr,
      prepayId,
      privateKeyPem: credentials.privateKeyPem,
    });
    return {
      mode: 'live',
      purpose: PAYMENT_PURPOSE_COFOUNDER,
      payNo: payment.payNo,
      orderId: null,
      amountFen: payment.amountFen,
      status: 'pending',
      appId: payer.appId,
      timeStamp,
      nonceStr,
      package: `prepay_id=${prepayId}`,
      signType: 'RSA',
      paySign,
    };
  }

  /**
   * 正式 JSAPI 下单的付款人。
   * openid 是 wechat_mini 身份上的 identifier，appId 是登录换这个 openid 时用的小程序 AppId。
   * 客户端没传的字段用这组身份补上；传了就必须一致，避免拿别人的 openid 下单。
   */
  private async payerForUser(
    userId: bigint,
    input: { appId?: string; openid?: string },
  ): Promise<{ appId: string; openid: string }> {
    const identity = await this.prisma.userIdentity.findFirst({
      where: { userId, provider: IDENTITY_PROVIDERS.wechatMini },
      orderBy: { id: 'asc' },
    });
    const sessionOpenid = identity?.identifier.trim() ?? '';
    if (!sessionOpenid) {
      throw new BadRequestException('当前账号没有微信小程序身份，无法微信支付下单');
    }
    const sessionAppId = this.env.wechatMiniAppId?.trim() ?? '';
    const suppliedAppId = input.appId?.trim() ?? '';
    const suppliedOpenid = input.openid?.trim() ?? '';
    if (
      (suppliedAppId !== '' && suppliedAppId !== sessionAppId) ||
      (suppliedOpenid !== '' && suppliedOpenid !== sessionOpenid)
    ) {
      throw new BadRequestException('appId 或 openid 与当前微信身份不一致');
    }
    const appId = suppliedAppId || sessionAppId;
    const openid = suppliedOpenid || sessionOpenid;
    if (!appId || !openid) {
      throw new BadRequestException('微信支付下单需要 appId 和 openid');
    }
    return { appId, openid };
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
          purpose: PAYMENT_PURPOSE_ORDER,
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
      if ((payment.purpose || PAYMENT_PURPOSE_ORDER) === PAYMENT_PURPOSE_COFOUNDER) {
        return this.finishActivation(
          tx,
          payment,
          input,
          now,
          amountFen,
          succeededAt,
          current,
          next,
        );
      }
      if (payment.orderId === null) {
        throw new NotFoundException('订单不存在');
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
      const settler = this.settler;
      if (becameSuccess && order.status === ORDER_PENDING_PAYMENT && !settler) {
        throw new InternalServerErrorException('订单结算未就绪');
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
      if (becameSuccess && order.status === ORDER_PENDING_PAYMENT && settler) {
        orderStatus = await settler.settleWechatSuccess(tx, order.id, now);
      } else if (becameFailed && settler) {
        await settler.releaseWechatFailure(tx, order.id, now);
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

  private async finishActivation(
    tx: Prisma.TransactionClient,
    payment: LockedPayment,
    input: ApplyTradeInput,
    now: Date,
    amountFen: number,
    succeededAt: Date | null,
    current: string,
    next: string,
  ): Promise<WechatPaymentResult> {
    if (payment.userId === null) {
      throw new NotFoundException('支付单不存在');
    }
    if (next === current) {
      return toPaymentResult({ ...payment, amountFen, succeededAt, orderId: null }, null);
    }
    const becameSuccess = next === 'success';
    const becameFailed = next === 'failed' && current === 'pending';
    if ((becameSuccess || becameFailed) && !this.activationSettler) {
      throw new InternalServerErrorException('联合创始人结算未就绪');
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
    if (becameSuccess || becameFailed) {
      await this.activationSettler?.onPaymentFinished(tx, {
        paymentId: payment.id,
        userId: payment.userId,
        amountFen,
        succeeded: becameSuccess,
        now,
      });
    }
    return toPaymentResult(
      {
        payNo: payment.payNo,
        status: next,
        orderId: null,
        amountFen,
        succeededAt: becameSuccess ? now : succeededAt,
      },
      null,
    );
  }
}

interface PaymentLockRow {
  id: bigint | number | string;
  orderId: bigint | number | string | null;
  payNo: string;
  channel: string;
  amountFen: number | string;
  status: string;
  succeededAt: Date | string | null;
  purpose?: string | null;
  userId?: bigint | number | string | null;
}

interface LockedPayment {
  id: bigint;
  orderId: bigint | null;
  payNo: string;
  channel: string;
  amountFen: number | string;
  status: string;
  succeededAt: Date | string | null;
  purpose: string;
  userId: bigint | null;
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
      succeeded_at AS succeededAt,
      purpose,
      user_id AS userId
    FROM payments
    WHERE pay_no = ${payNo}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    ...row,
    id: asBigInt(row.id),
    orderId: row.orderId === null || row.orderId === undefined ? null : asBigInt(row.orderId),
    purpose:
      typeof row.purpose === 'string' && row.purpose.length > 0
        ? row.purpose
        : PAYMENT_PURPOSE_ORDER,
    userId: row.userId === null || row.userId === undefined ? null : asBigInt(row.userId),
  };
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
    orderId: bigint | null;
    amountFen: number;
    succeededAt: Date | null;
  },
  orderStatus: string | null,
): WechatPaymentResult {
  return {
    payNo: payment.payNo,
    status: payment.status,
    orderId: payment.orderId === null ? null : payment.orderId.toString(),
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

function requireExplicitPayer(input: CreateWechatPrepayInput): { appId: string; openid: string } {
  const appId = input.appId?.trim() ?? '';
  const openid = input.openid?.trim() ?? '';
  if (!appId || !openid) {
    throw new BadRequestException('微信支付下单需要 appId 和 openid');
  }
  return { appId, openid };
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
