import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { Order, OrderRefund } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WechatPayGateway } from '../payments/wechat-pay.gateway';
import { WechatPaySettingsService } from '../payments/wechat-pay-settings.service';
import { WECHAT_PAY_CHANNEL } from '../payments/wechat-pay.constants';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { CashLedgerService } from '../wallet/cash-ledger.service';
import {
  CASH_WECHAT_REFUND,
  LEDGER_MALL_REFUND,
  WALLET_CONSUMPTION,
  WITHDRAWAL_PENDING,
} from '../wallet/wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import { ORDER_PAID, ORDER_SHIPPED } from './order.constants';
import { allocateMallRefund, resolveRefundAmounts } from './refund-split';

const REFUND_PENDING = 'pending';
const REFUND_APPROVED = 'approved';
const REFUND_REJECTED = 'rejected';
const WECHAT_NONE = 'none';
const WECHAT_SANDBOX = 'sandbox';
const WECHAT_ACCEPTED = 'accepted';
const DEDUCTION_HINT = '运费和其他应扣费用不会自动计入减扣';

export interface RefundView {
  id: bigint;
  orderId: bigint;
  userId: bigint;
  status: string;
  payAmountFen: number;
  freightFen: number;
  deductionHint: string;
  refundFen: number | null;
  deductionFen: number | null;
  wechatRefundFen: number | null;
  withdrawableDeductionFen: number | null;
  consumptionCreditFen: number | null;
  wechatRefundStatus: string | null;
  appliedAt: string;
  decidedAt: string | null;
}

export interface RefundPage {
  items: RefundView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 会员商城退款。用户申请，财务审核。创业专区不能退。
 * 审核通过后不回滚已发奖励，也不动分红池。
 * 有未完成提现时不能申请。
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    private readonly cash: CashLedgerService,
    @Inject(forwardRef(() => WechatPaySettingsService))
    private readonly settings: WechatPaySettingsService,
    @Inject(forwardRef(() => WechatPayGateway))
    private readonly gateway: WechatPayGateway,
  ) {}

  async apply(userId: bigint, orderId: bigint): Promise<RefundView> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    assertRefundableOrder(order);
    const now = await this.clock.now();
    const created = await this.prisma.$transaction(async (tx) => {
      const openWithdrawal = await tx.withdrawalApplication.findFirst({
        where: { userId, status: WITHDRAWAL_PENDING },
      });
      if (openWithdrawal) {
        throw new ConflictException('有未完成的提现，不能申请退款');
      }
      const blocking = await tx.orderRefund.findFirst({
        where: { orderId, status: { in: [REFUND_PENDING, REFUND_APPROVED] } },
      });
      if (blocking) {
        throw new ConflictException('订单已有退款申请');
      }
      return tx.orderRefund.create({
        data: {
          orderId,
          userId,
          status: REFUND_PENDING,
          payAmountFen: order.payAmountFen,
          freightFen: order.freightFen,
          refundFen: null,
          deductionFen: null,
          wechatRefundFen: null,
          withdrawableDeductionFen: null,
          consumptionCreditFen: null,
          wechatRefundStatus: null,
          wechatRefundNo: null,
          appliedAt: now,
          decidedAt: null,
          decidedByAdminId: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    });
    return toView(created);
  }

  async listForUser(userId: bigint, page: number, pageSize: number): Promise<RefundPage> {
    return this.list({ userId }, page, pageSize);
  }

  async getForUser(userId: bigint, id: bigint): Promise<RefundView> {
    const row = await this.prisma.orderRefund.findFirst({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException('退款申请不存在');
    }
    return toView(row);
  }

  async listAdmin(query: {
    status?: string;
    userId?: bigint;
    page: number;
    pageSize: number;
  }): Promise<RefundPage> {
    if (
      query.status !== undefined &&
      query.status !== REFUND_PENDING &&
      query.status !== REFUND_APPROVED &&
      query.status !== REFUND_REJECTED
    ) {
      throw new BadRequestException('状态不正确');
    }
    return this.list(
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
      },
      query.page,
      query.pageSize,
    );
  }

  async approve(
    id: bigint,
    adminId: bigint,
    input: { refundFen?: number; deductionFen?: number },
  ): Promise<RefundView> {
    const current = await this.prisma.orderRefund.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException('退款申请不存在');
    }
    if (current.status !== REFUND_PENDING) {
      throw new ConflictException('退款申请已处理');
    }
    const order = await this.prisma.order.findUnique({ where: { id: current.orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    assertRefundableOrder(order);
    const amounts = resolveRefundAmounts(order.payAmountFen, input);
    const allocation = allocateMallRefund({
      payAmountFen: order.payAmountFen,
      consumptionFen: order.consumptionFen,
      withdrawableFen: order.withdrawableFen,
      wechatFen: order.wechatFen,
      pointsFen: order.pointsFen,
      deductionFen: amounts.deductionFen,
    });
    const credentials = await this.settings.readCredentials();
    let wechatRefundNo: string | null = null;
    let wechatRefundStatus = WECHAT_NONE;
    if (allocation.wechatRefundFen > 0) {
      wechatRefundNo = createRefundNo(current.id);
      if (credentials) {
        const payment = await this.prisma.payment.findFirst({
          where: { orderId: order.id, channel: WECHAT_PAY_CHANNEL, status: 'success' },
          orderBy: { id: 'desc' },
        });
        if (!payment || payment.amountFen !== order.wechatFen) {
          throw new ConflictException('缺少微信支付记录');
        }
        await this.gateway.createDomesticRefund({
          merchantId: credentials.merchantId,
          privateKeyPem: credentials.privateKeyPem,
          certificateSerial: credentials.serialNumber,
          outTradeNo: payment.payNo,
          outRefundNo: wechatRefundNo,
          refundFen: allocation.wechatRefundFen,
          totalFen: payment.amountFen,
        });
        wechatRefundStatus = WECHAT_ACCEPTED;
      } else {
        wechatRefundStatus = WECHAT_SANDBOX;
      }
    }
    const now = await this.clock.now();
    const updated = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.orderRefund.findUnique({ where: { id: current.id } });
      if (!fresh || fresh.status !== REFUND_PENDING) {
        throw new ConflictException('退款申请已处理');
      }
      const freshOrder = await tx.order.findUnique({ where: { id: fresh.orderId } });
      if (!freshOrder) {
        throw new NotFoundException('订单不存在');
      }
      const again = allocateMallRefund({
        payAmountFen: freshOrder.payAmountFen,
        consumptionFen: freshOrder.consumptionFen,
        withdrawableFen: freshOrder.withdrawableFen,
        wechatFen: freshOrder.wechatFen,
        pointsFen: freshOrder.pointsFen,
        deductionFen: amounts.deductionFen,
      });
      if (
        again.wechatRefundFen !== allocation.wechatRefundFen ||
        again.consumptionCreditFen !== allocation.consumptionCreditFen ||
        again.refundFen !== allocation.refundFen
      ) {
        throw new ConflictException('退款金额已变化');
      }
      if (again.consumptionCreditFen > 0) {
        await this.wallet.lockAll(tx, fresh.userId, now);
        await this.wallet.creditInTx(
          tx,
          {
            userId: fresh.userId,
            walletType: WALLET_CONSUMPTION,
            amountFen: BigInt(again.consumptionCreditFen),
            bizType: LEDGER_MALL_REFUND,
            bizId: fresh.id.toString(),
            sourceCode: null,
          },
          now,
        );
      }
      await this.cash.recordOutflow(tx, {
        amountFen: BigInt(again.wechatRefundFen),
        bizType: CASH_WECHAT_REFUND,
        bizId: fresh.id.toString(),
        occurredAt: now,
      });
      return tx.orderRefund.update({
        where: { id: fresh.id },
        data: {
          status: REFUND_APPROVED,
          refundFen: again.refundFen,
          deductionFen: again.deductionFen,
          wechatRefundFen: again.wechatRefundFen,
          withdrawableDeductionFen: again.withdrawableDeductionFen,
          consumptionCreditFen: again.consumptionCreditFen,
          wechatRefundStatus,
          wechatRefundNo,
          decidedAt: now,
          decidedByAdminId: adminId,
          updatedAt: now,
        },
      });
    });
    return toView(updated);
  }

  async reject(id: bigint, adminId: bigint): Promise<RefundView> {
    const now = await this.clock.now();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.orderRefund.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('退款申请不存在');
      }
      if (current.status !== REFUND_PENDING) {
        throw new ConflictException('退款申请已处理');
      }
      return tx.orderRefund.update({
        where: { id: current.id },
        data: {
          status: REFUND_REJECTED,
          decidedAt: now,
          decidedByAdminId: adminId,
          updatedAt: now,
        },
      });
    });
    return toView(updated);
  }

  private async list(
    where: { userId?: bigint; status?: string },
    page: number,
    pageSize: number,
  ): Promise<RefundPage> {
    const [total, rows] = await Promise.all([
      this.prisma.orderRefund.count({ where }),
      this.prisma.orderRefund.findMany({
        where,
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toView), total, page, pageSize };
  }
}

function assertRefundableOrder(order: Order): void {
  if (order.zone === PRODUCT_ZONE_STARTUP) {
    throw new BadRequestException('创业专区订单不能退款');
  }
  if (order.zone !== PRODUCT_ZONE_MALL) {
    throw new BadRequestException('订单不能退款');
  }
  if (order.status !== ORDER_PAID && order.status !== ORDER_SHIPPED) {
    throw new ConflictException('订单不能退款');
  }
}

function createRefundNo(refundId: bigint): string {
  return `R${refundId.toString()}${randomBytes(4).toString('hex')}`.slice(0, 64);
}

function toView(row: OrderRefund): RefundView {
  return {
    id: row.id,
    orderId: row.orderId,
    userId: row.userId,
    status: row.status,
    payAmountFen: row.payAmountFen,
    freightFen: row.freightFen,
    deductionHint: DEDUCTION_HINT,
    refundFen: row.refundFen,
    deductionFen: row.deductionFen,
    wechatRefundFen: row.wechatRefundFen,
    withdrawableDeductionFen: row.withdrawableDeductionFen,
    consumptionCreditFen: row.consumptionCreditFen,
    wechatRefundStatus: row.wechatRefundStatus,
    appliedAt: row.appliedAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}
