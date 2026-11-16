import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Order, OrderItem, Prisma, Product, ProductSku } from '@prisma/client';
import { USER_STATUS_ACTIVE } from '../../common/auth/user-status';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { APP_ENV, LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import {
  PRODUCT_STATUS_ON,
  PRODUCT_ZONE_MALL,
  PRODUCT_ZONE_STARTUP,
  PRODUCT_ZONES,
} from '../catalog/catalog.constants';
import { WECHAT_PAY_CHANNEL } from '../payments/wechat-pay.constants';
import { WechatPayService, type WechatPrepayView } from '../payments/wechat-pay.service';
import { TreesService } from '../rewards/trees/trees.service';
import {
  HOLD_HELD,
  WALLET_CONSUMPTION,
  WALLET_POINTS,
  WALLET_WITHDRAWABLE,
  type WalletType,
} from '../wallet/wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import { OrderPaymentSettler } from './order-payment.settler';
import {
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  ORDER_CLOSED,
  ORDER_PAID,
  ORDER_PENDING_PAYMENT,
  ORDER_SHIPPED,
  ORDER_STATUSES,
  addFen,
  mulFen,
} from './order.constants';
import {
  COMPENSATION_ACTIVE_STATUSES,
} from './settlement-compensation.constants';
import { splitMall, splitStartup } from './payment-split';

type Tx = Prisma.TransactionClient;

export interface OrderLineInput {
  productId: bigint;
  quantity: number;
}

export interface CreateOrderInput {
  zone: string;
  addressId: bigint;
  items: OrderLineInput[];
}

export interface PayOrderInput {
  appId?: string;
  openid?: string;
}

export interface OrderItemView {
  id: bigint;
  skuId: bigint;
  productName: string;
  skuName: string;
  unitPriceFen: number;
  unitPvFen: number;
  unitFreightFen: number;
  quantity: number;
  lineTotalFen: number;
  linePvFen: number;
  lineFreightFen: number;
}

export interface OrderView {
  id: bigint;
  orderNo: string;
  userId: bigint;
  zone: string;
  status: string;
  goodsTotalFen: number;
  freightFen: number;
  payAmountFen: number;
  pvFen: number;
  pointsFen: number;
  withdrawableFen: number;
  consumptionFen: number;
  wechatFen: number;
  shipping: {
    contactName: string;
    contactPhone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
  };
  courierName: string | null;
  trackingNumber: string | null;
  items: OrderItemView[];
  placedAt: string;
  /** 待支付订单的自动关闭时刻。null 表示不限时（ORDER_PAYMENT_TIMEOUT_MINUTES=0）或订单已不在待支付。 */
  payDeadline: string | null;
  /**
   * 微信已支付但结算未完成：存在活跃的结算补偿记录（自动重试或待人工）。
   * 界面据此显示黄色异常标记；结算完成后自动消失，无需人工清除。
   */
  settlementPending: boolean;
  /** 活跃结算补偿的 id；settlementPending 为 false 时为 null。管理端用它直接发起继续结算。 */
  compensationId: string | null;
  /** 运营备注。人工强制完成结算时由系统写入缺口与入座处理说明；用户端不展示。 */
  remark: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  closedAt: string | null;
}

export interface OrderPage {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PayOrderResult {
  order: OrderView;
  wechat: WechatPrepayView | null;
}

interface QuotedLine {
  skuId: bigint;
  productName: string;
  skuName: string;
  unitPriceFen: number;
  unitPvFen: number;
  unitFreightFen: number;
  unitCostFen: number | null;
  quantity: number;
  lineTotalFen: number;
  linePvFen: number;
  lineFreightFen: number;
}

/**
 * 创业专区和会员商城下单。
 * 支付顺序固定，调用方不能改来源。账户够付时不发起微信支付。
 * 需要微信支付时先冻结账户份额，成功后再扣款；创业专区同时入座。库存不参与下单与结算。
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    private readonly trees: TreesService,
    private readonly settlement: OrderPaymentSettler,
    @Inject(forwardRef(() => WechatPayService))
    private readonly wechat: WechatPayService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async create(userId: bigint, input: CreateOrderInput): Promise<OrderView> {
    const zone = parseZone(input.zone);
    const items = normalizeItems(input.items);
    const now = await this.clock.now();
    const orderId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== USER_STATUS_ACTIVE) {
        throw new UnauthorizedException('登录已失效');
      }
      if (zone === PRODUCT_ZONE_MALL && !user.member) {
        throw new ForbiddenException('非会员不能购买会员商城');
      }
      if (zone === PRODUCT_ZONE_STARTUP && !user.seated) {
        await this.trees.assertCanSeat(tx, userId);
      }
      const address = await tx.userAddress.findFirst({
        where: { id: input.addressId, userId },
      });
      if (!address) {
        throw new NotFoundException('地址不存在');
      }
      const lines = await this.quote(tx, zone, items);
      let goodsTotalFen = 0;
      let freightFen = 0;
      let pvFen = 0;
      for (const line of lines) {
        goodsTotalFen = checkedAdd(goodsTotalFen, line.lineTotalFen);
        freightFen = checkedAdd(freightFen, line.lineFreightFen);
        pvFen = checkedAdd(pvFen, line.linePvFen);
      }
      const payAmountFen = checkedAdd(goodsTotalFen, freightFen);
      const order = await tx.order.create({
        data: {
          orderNo: createOrderNo(zone, now),
          userId,
          zone,
          status: ORDER_PENDING_PAYMENT,
          goodsTotalFen,
          freightFen,
          payAmountFen,
          pvFen,
          pointsFen: 0,
          withdrawableFen: 0,
          consumptionFen: 0,
          wechatFen: 0,
          contactName: address.contactName,
          contactPhone: address.contactPhone,
          province: address.province,
          city: address.city,
          district: address.district,
          detail: address.detail,
          placedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.orderItem.createMany({
        data: lines.map((line) => ({
          orderId: order.id,
          skuId: line.skuId,
          productName: line.productName,
          skuName: line.skuName,
          unitPriceFen: line.unitPriceFen,
          pvFen: line.unitPvFen,
          freightFen: line.unitFreightFen,
          unitCostFen: line.unitCostFen,
          quantity: line.quantity,
          lineTotalFen: line.lineTotalFen,
          createdAt: now,
        })),
      });
      return order.id;
    });
    return this.getForUser(userId, orderId);
  }

  async pay(userId: bigint, orderId: bigint, input: PayOrderInput = {}): Promise<PayOrderResult> {
    const now = await this.clock.now();
    const mode = await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      const order = await this.requirePending(tx, orderId, userId);
      const pendingPayment = await tx.payment.findFirst({
        where: { orderId, channel: WECHAT_PAY_CHANNEL, status: 'pending' },
      });
      if (pendingPayment) {
        return 'wechat' as const;
      }
      const held = await tx.walletHold.findFirst({ where: { orderId, status: HOLD_HELD } });
      if (!held) {
        await this.prepareSplit(tx, order, now);
      }
      const fresh = await tx.order.findUnique({ where: { id: orderId } });
      if (!fresh) {
        throw new NotFoundException('订单不存在');
      }
      if (fresh.wechatFen === 0) {
        await this.settlement.finish(tx, orderId, now, 'wallet');
        return 'paid' as const;
      }
      return 'wechat' as const;
    });
    if (mode === 'paid') {
      return { order: await this.getForUser(userId, orderId), wechat: null };
    }
    const current = await this.getForUser(userId, orderId);
    const wechat = await this.wechat.createPrepay({
      orderId: orderId.toString(),
      userId,
      appId: input.appId,
      openid: input.openid,
      description: `订单${current.orderNo}`,
    });
    return { order: await this.getForUser(userId, orderId), wechat };
  }

  async cancel(userId: bigint, orderId: bigint): Promise<OrderView> {
    await this.closePending(userId, orderId);
    return this.getForUser(userId, orderId);
  }

  /** 关闭仍待支付的订单并释放冻结。本阶段不按固定时长自动关闭。 */
  async timeout(userId: bigint, orderId: bigint): Promise<OrderView> {
    await this.closePending(userId, orderId);
    return this.getForUser(userId, orderId);
  }

  async listForUser(userId: bigint, page: number, pageSize: number): Promise<OrderPage> {
    return this.list({ userId, page, pageSize });
  }

  async getForUser(userId: bigint, orderId: bigint): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return this.toView(order);
  }

  async listAdmin(query: {
    zone?: string;
    status?: string;
    userId?: bigint;
    page: number;
    pageSize: number;
  }): Promise<OrderPage> {
    return this.list({
      zone: query.zone === undefined ? undefined : parseZone(query.zone),
      status: query.status === undefined ? undefined : parseStatus(query.status),
      userId: query.userId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  async getAdmin(orderId: bigint): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return this.toView(order);
  }

  async ship(
    orderId: bigint,
    input: { courierName: string; trackingNumber: string },
  ): Promise<OrderView> {
    const courierName = requiredText(input.courierName, '快递公司', 64);
    const trackingNumber = requiredText(input.trackingNumber, '运单号', 64);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
      if (order.status === ORDER_SHIPPED) {
        throw new ConflictException('订单已发货');
      }
      if (order.status !== ORDER_PAID) {
        throw new ConflictException('只有已支付的订单可以发货');
      }
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: ORDER_SHIPPED,
          courierName,
          trackingNo: trackingNumber,
          shippedAt: now,
          updatedAt: now,
        },
      });
    });
    return this.getAdmin(orderId);
  }

  private async prepareSplit(tx: Tx, order: Order, now: Date): Promise<void> {
    await this.wallet.lockAll(tx, order.userId, now);
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      const user = await tx.user.findUnique({ where: { id: order.userId } });
      if (!user?.seated) {
        await this.trees.assertCanSeat(tx, order.userId);
      }
    }
    const points = await this.wallet.availableFen(tx, order.userId, WALLET_POINTS);
    const withdrawable = await this.wallet.availableFen(tx, order.userId, WALLET_WITHDRAWABLE);
    const consumption = await this.wallet.availableFen(tx, order.userId, WALLET_CONSUMPTION);
    const split =
      order.zone === PRODUCT_ZONE_STARTUP
        ? splitStartup(order.payAmountFen, points, withdrawable, this.unitPrice())
        : splitMall(order.payAmountFen, consumption, withdrawable);
    const portions: Array<[WalletType, number]> = [
      [WALLET_CONSUMPTION, split.consumptionFen],
      [WALLET_POINTS, split.pointsFen],
      [WALLET_WITHDRAWABLE, split.withdrawableFen],
    ];
    for (const [walletType, amount] of portions) {
      if (amount > 0) {
        await this.wallet.hold(tx, order.userId, walletType, BigInt(amount), order.id, now);
      }
    }
    await tx.order.update({
      where: { id: order.id },
      data: {
        pointsFen: split.pointsFen,
        withdrawableFen: split.withdrawableFen,
        consumptionFen: split.consumptionFen,
        wechatFen: split.wechatFen,
        updatedAt: now,
      },
    });
  }

  private async closePending(userId: bigint, orderId: bigint): Promise<void> {
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      await this.requirePending(tx, orderId, userId);
      await this.wallet.releaseHolds(tx, orderId, now);
      const pending = await tx.payment.findFirst({
        where: { orderId, channel: WECHAT_PAY_CHANNEL, status: 'pending' },
      });
      if (pending) {
        await tx.payment.update({
          where: { id: pending.id },
          data: { status: 'failed', activeSlot: null, updatedAt: now },
        });
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: ORDER_CLOSED, closedAt: now, updatedAt: now },
      });
    });
  }

  private async requirePending(tx: Tx, orderId: bigint, userId: bigint): Promise<Order> {
    const order = await tx.order.findFirst({ where: { id: orderId, userId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (order.status !== ORDER_PENDING_PAYMENT) {
      throw new ConflictException('订单不在待支付状态');
    }
    return order;
  }

  private async quote(tx: Tx, zone: string, items: OrderLineInput[]): Promise<QuotedLine[]> {
    const lines: QuotedLine[] = [];
    for (const item of items) {
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product) {
        throw new NotFoundException('商品不存在');
      }
      if (product.zone !== zone) {
        throw new BadRequestException('商品专区不一致');
      }
      if (product.status !== PRODUCT_STATUS_ON) {
        throw new BadRequestException('商品未上架');
      }
      const sku = await tx.productSku.findFirst({
        where: { productId: product.id },
        orderBy: { id: 'asc' },
      });
      if (!sku || sku.status !== PRODUCT_STATUS_ON) {
        throw new BadRequestException('商品未上架');
      }
      lines.push(quoteLine(zone, product, sku, item.quantity, this.unitPrice()));
    }
    return lines;
  }

  private async list(query: {
    userId?: bigint;
    zone?: string;
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<OrderPage> {
    const where: Prisma.OrderWhereInput = {};
    if (query.userId !== undefined) {
      where.userId = query.userId;
    }
    if (query.zone !== undefined) {
      where.zone = query.zone;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const items: OrderView[] = [];
    for (const row of rows) {
      items.push(await this.toView(row));
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  private async toView(order: Order): Promise<OrderView> {
    const rows = await this.prisma.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { id: 'asc' },
    });
    const pendingCompensation = await this.prisma.settlementCompensation.findFirst({
      where: { orderId: order.id, status: { in: [...COMPENSATION_ACTIVE_STATUSES] } },
      orderBy: { id: 'desc' },
    });
    return {
      id: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      zone: order.zone,
      status: order.status,
      goodsTotalFen: order.goodsTotalFen,
      freightFen: order.freightFen,
      payAmountFen: order.payAmountFen,
      pvFen: order.pvFen,
      pointsFen: order.pointsFen,
      withdrawableFen: order.withdrawableFen,
      consumptionFen: order.consumptionFen,
      wechatFen: order.wechatFen,
      shipping: {
        contactName: order.contactName,
        contactPhone: order.contactPhone,
        province: order.province,
        city: order.city,
        district: order.district,
        detail: order.detail,
      },
      courierName: order.courierName,
      trackingNumber: order.trackingNo,
      items: rows.map(toItemView),
      placedAt: order.placedAt.toISOString(),
      settlementPending: pendingCompensation != null,
      compensationId: pendingCompensation ? pendingCompensation.id.toString() : null,
      remark: order.remark,
      payDeadline: this.payDeadlineOf(order),
      paidAt: order.paidAt ? order.paidAt.toISOString() : null,
      shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
      closedAt: order.closedAt ? order.closedAt.toISOString() : null,
    };
  }

  /** 前端倒计时用。与定时关单共用同一份设置，避免两处时长不一致。 */
  private payDeadlineOf(order: Order): string | null {
    if (order.status !== ORDER_PENDING_PAYMENT) {
      return null;
    }
    const minutes = this.env.orderPaymentTimeoutMinutes;
    if (minutes <= 0) {
      return null;
    }
    return this.clock.instant(order.placedAt.getTime() + minutes * 60_000).toISOString();
  }

  private unitPrice(): number {
    const unit = this.locked.startupZoneUnitPriceFen;
    if (!Number.isInteger(unit) || unit <= 0) {
      throw new BadRequestException('创业专区单价无效');
    }
    return unit;
  }
}

function quoteLine(
  zone: string,
  product: Product,
  sku: ProductSku,
  quantity: number,
  unitPrice: number,
): QuotedLine {
  const priceFen = zone === PRODUCT_ZONE_STARTUP ? unitPrice : sku.priceFen;
  if (zone === PRODUCT_ZONE_STARTUP && sku.priceFen !== unitPrice) {
    throw new BadRequestException('创业专区商品售价不正确');
  }
  if (!Number.isInteger(priceFen) || priceFen < 0) {
    throw new BadRequestException('商品价格不正确');
  }
  const unitPvFen = zone === PRODUCT_ZONE_MALL ? sku.pvFen : 0;
  if (
    zone === PRODUCT_ZONE_MALL &&
    (unitPvFen === null || !Number.isInteger(unitPvFen) || unitPvFen < 0)
  ) {
    throw new BadRequestException('商品 PV 不正确');
  }
  if (!Number.isInteger(product.freightFen) || product.freightFen < 0) {
    throw new BadRequestException('运费不正确');
  }
  if (sku.costFen !== null && (!Number.isInteger(sku.costFen) || sku.costFen < 0)) {
    throw new BadRequestException('成本价不正确');
  }
  const pv = unitPvFen ?? 0;
  return {
    skuId: sku.id,
    productName: product.name,
    skuName: sku.name,
    unitPriceFen: priceFen,
    unitPvFen: pv,
    unitFreightFen: product.freightFen,
    unitCostFen: sku.costFen,
    quantity,
    lineTotalFen: checkedMul(priceFen, quantity),
    linePvFen: checkedMul(pv, quantity),
    lineFreightFen: checkedMul(product.freightFen, quantity),
  };
}

function toItemView(row: OrderItem): OrderItemView {
  return {
    id: row.id,
    skuId: row.skuId,
    productName: row.productName,
    skuName: row.skuName,
    unitPriceFen: row.unitPriceFen,
    unitPvFen: row.pvFen,
    unitFreightFen: row.freightFen,
    quantity: row.quantity,
    lineTotalFen: row.lineTotalFen,
    linePvFen: checkedMul(row.pvFen, row.quantity),
    lineFreightFen: checkedMul(row.freightFen, row.quantity),
  };
}

function normalizeItems(items: OrderLineInput[]): OrderLineInput[] {
  if (items.length < 1 || items.length > MAX_ORDER_LINES) {
    throw new BadRequestException('请选择商品');
  }
  const seen = new Set<string>();
  return items.map((item) => {
    const key = item.productId.toString();
    if (seen.has(key)) {
      throw new BadRequestException('商品重复');
    }
    seen.add(key);
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_LINE_QUANTITY
    ) {
      throw new BadRequestException('数量不正确');
    }
    return { productId: item.productId, quantity: item.quantity };
  });
}

function parseZone(zone: string): string {
  if (!(PRODUCT_ZONES as readonly string[]).includes(zone)) {
    throw new BadRequestException('专区不正确');
  }
  return zone;
}

function parseStatus(status: string): string {
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException('订单状态不正确');
  }
  return status;
}

function requiredText(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new BadRequestException(`${label}不正确`);
  }
  return trimmed;
}

function checkedAdd(left: number, right: number): number {
  try {
    return addFen(left, right);
  } catch {
    throw new BadRequestException('订单金额超出范围');
  }
}

function checkedMul(unit: number, quantity: number): number {
  try {
    return mulFen(unit, quantity);
  } catch {
    throw new BadRequestException('订单金额超出范围');
  }
}

async function lockOrder(tx: Tx, orderId: bigint): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
}

function createOrderNo(zone: string, now: Date): string {
  const prefix = zone === PRODUCT_ZONE_STARTUP ? 'S' : 'M';
  const time = now.getTime().toString(36).toUpperCase();
  const rand = randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}${time}${rand}`.slice(0, 32);
}
