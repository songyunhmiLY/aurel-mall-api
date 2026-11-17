import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CashLedgerService } from '../wallet/cash-ledger.service';
import { CASH_WECHAT_REFUND } from '../wallet/wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import { WechatPayGateway, WechatRefundAlreadyAccepted } from '../payments/wechat-pay.gateway';
import { WechatPaySettingsService } from '../payments/wechat-pay-settings.service';
import {
  OrderPaymentSettler,
  classifySettlementError,
} from './order-payment.settler';
import {
  COMPENSATION_ACTIVE_STATUSES,
  COMPENSATION_AUTO_RETRY,
  COMPENSATION_COMPLETED,
  COMPENSATION_MAX_RETRY,
  COMPENSATION_REFUNDED,
  COMPENSATION_RETRY_INTERVAL_MS,
} from './settlement-compensation.constants';

type Tx = Prisma.TransactionClient;

export interface CompensationView {
  id: string;
  orderId: string;
  orderNo: string;
  userId: string;
  zone: string;
  payNo: string;
  wechatTradeNo: string | null;
  amountFen: string;
  failReason: string;
  status: string;
  retryCount: number;
  lastError: string | null;
  lastTriedAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
}

export interface CompensationPage {
  items: CompensationView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 结算补偿。原则：钱已收到，优先继续完成订单，退款只是最后兜底。
 * 库存不参与结算，因此不会因库存失败。
 * 分流：
 *   - 钱包份额不足 → 待人工（订单页黄色「！」标记 + 手动完成结算）
 *   - 订单被超时取消 / 入座失败 / 环境类故障 → 自动重试
 */
@Injectable()
export class SettlementCompensationService {
  private readonly logger = new Logger(SettlementCompensationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    private readonly settler: OrderPaymentSettler,
    private readonly cash: CashLedgerService,
    private readonly settings: WechatPaySettingsService,
    private readonly gateway: WechatPayGateway,
  ) {}

  /**
   * 重试一笔补偿。自动重试任务与管理端「继续结算」共用；
   * 钱包份额不足时不垫钱，转待人工，由订单页手动完成结算兜底。
   */
  async retryOne(
    compensationId: bigint,
    opts: { adminId?: bigint | null } = {},
  ): Promise<CompensationView> {
    const now = await this.clock.now();
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM settlement_compensations WHERE id = ${compensationId} FOR UPDATE
      `;
      const comp = await tx.settlementCompensation.findUnique({
        where: { id: compensationId },
      });
      if (!comp) {
        throw new NotFoundException('补偿记录不存在');
      }
      if (comp.status === COMPENSATION_COMPLETED || comp.status === COMPENSATION_REFUNDED) {
        return { id: comp.id, status: comp.status, failReason: comp.failReason };
      }
      const order = await tx.order.findUnique({ where: { id: comp.orderId } });
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
      if (this.settler.orderAlreadySettled(order.status)) {
        await this.markCompleted(tx, comp.id, opts.adminId ?? null, now);
        return { id: comp.id, status: COMPENSATION_COMPLETED, failReason: comp.failReason };
      }
      try {
        await this.settler.finishForCompensation(tx, order.id, now);
      } catch (error) {
        const classified = classifySettlementError(error);        await tx.settlementCompensation.update({
          where: { id: comp.id },
          data: {
            status: classified.status,
            failReason: classified.reason,
            lastError: readMessage(error),
            lastTriedAt: now,
            retryCount: { increment: 1 },
            operatorAdminId: opts.adminId ?? comp.operatorAdminId,
            updatedAt: now,
          },
        });
        return { id: comp.id, status: classified.status, failReason: classified.reason };
      }
      await this.markCompleted(tx, comp.id, opts.adminId ?? null, now);
      return { id: comp.id, status: COMPENSATION_COMPLETED, failReason: comp.failReason };
    });
    this.logger.log(
      `settlement compensation ${outcome.id} -> ${outcome.status} (${outcome.failReason ?? '-'})`,
    );
    return this.viewOf(await this.prisma.settlementCompensation.findUnique({
      where: { id: outcome.id },
    }));
  }

  /** 定时任务入口。只处理 auto_retry 状态、未到重试间隔、未超次数上限的记录。 */
  async runDue(limit = 20): Promise<number> {
    const now = await this.clock.now();
    const cutoff = now.getTime() - COMPENSATION_RETRY_INTERVAL_MS;
    const candidates = await this.prisma.settlementCompensation.findMany({
      where: { status: COMPENSATION_AUTO_RETRY, retryCount: { lt: COMPENSATION_MAX_RETRY } },
      orderBy: { lastTriedAt: 'asc' },
    });
    const due = candidates
      .filter((row) => !row.lastTriedAt || row.lastTriedAt.getTime() < cutoff)
      .slice(0, limit);
    let attempted = 0;
    for (const row of due) {
      try {
        await this.retryOne(row.id);
        attempted += 1;
      } catch (error) {
        this.logger.warn(
          `settlement compensation retry failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    return attempted;
  }

  async list(input: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<CompensationPage> {
    const where = input.status ? { status: input.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.settlementCompensation.count({ where }),
      this.prisma.settlementCompensation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
    ]);
    const orders = await this.prisma.order.findMany({
      where: { id: { in: rows.map((row) => row.orderId) } },
      select: { id: true, orderNo: true },
    });
    const orderNoById = new Map(orders.map((order) => [order.id, order.orderNo]));
    return {
      items: rows.map((row) => this.toView(row, orderNoById.get(row.orderId) ?? '')),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  /**
   * 管理端「手动完成结算」：钱包冻结份额不够扣就扣到可扣尽的最低值（创业专区按单价
   * 对齐，零头留在账户）、缺口写进订单备注；创业专区订单未入座的尝试入座，入座失败
   * 也写备注后继续。订单转为已支付，补偿记录关闭。供运营在系统外处理完后一键恢复订单。
   */
  async forceComplete(
    orderId: bigint,
    adminId: bigint | null,
  ): Promise<{ view: CompensationView; note: string }> {
    const now = await this.clock.now();
    const note = await this.prisma.$transaction(async (tx) => {
      const comp = await tx.settlementCompensation.findFirst({
        where: { orderId, status: { in: [...COMPENSATION_ACTIVE_STATUSES] } },
        orderBy: { id: 'desc' },
      });
      if (!comp) {
        throw new NotFoundException('该订单没有待处理的结算补偿');
      }
      await tx.$queryRaw`
        SELECT id FROM settlement_compensations WHERE id = ${comp.id} FOR UPDATE
      `;
      const remark = await this.settler.forceFinish(tx, orderId, now);
      await this.markCompleted(tx, comp.id, adminId, now);
      return remark;
    });
    this.logger.log(`settlement compensation force-complete for order ${orderId}: ${note}`);
    const comp = await this.prisma.settlementCompensation.findFirst({
      where: { orderId },
      orderBy: { id: 'desc' },
    });
    return { view: await this.viewOf(comp), note };
  }

  /**
   * 转退款。微信实收原路退回（幂等退款单号），钱包冻结份额解冻回账户。
   * 订单已结算完成则拒绝；这属于运营兜底操作，不是用户退款申请。
   *
   * @deprecated 退款能力已整体下线：管理端路由返回 410，商城不再支持退货退款，
   * 补偿只能通过「继续结算」推进。方法保留仅为历史数据解释与将来可能的恢复，
   * 重新启用前必须先补上状态预占（CAS 到中间态）再调微信，否则与重试并发会造成重复退款。
   */
  async refund(compensationId: bigint, adminId: bigint): Promise<CompensationView> {
    const now = await this.clock.now();
    const comp = await this.prisma.settlementCompensation.findUnique({
      where: { id: compensationId },
    });
    if (!comp) {
      throw new NotFoundException('补偿记录不存在');
    }
    if (comp.status === COMPENSATION_COMPLETED) {
      throw new ConflictException('订单已完成结算，不能转退款');
    }
    if (comp.status === COMPENSATION_REFUNDED) {
      return this.viewOf(comp);
    }
    const order = await this.prisma.order.findUnique({ where: { id: comp.orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (this.settler.orderAlreadySettled(order.status)) {
      throw new ConflictException('订单已支付，走商城退款流程');
    }
    const credentials = await this.settings.readCredentials();
    if (credentials) {
      try {
        await this.gateway.createDomesticRefund({
          merchantId: credentials.merchantId,
          privateKeyPem: credentials.privateKeyPem,
          certificateSerial: credentials.serialNumber,
          outTradeNo: comp.payNo,
          outRefundNo: compensationRefundNo(comp.id),
          refundFen: comp.amountFen,
          totalFen: comp.amountFen,
        });
      } catch (error) {
        if (!(error instanceof WechatRefundAlreadyAccepted)) {
          throw error;
        }
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM settlement_compensations WHERE id = ${compensationId} FOR UPDATE
      `;
      const fresh = await tx.settlementCompensation.findUnique({
        where: { id: compensationId },
      });
      if (!fresh || fresh.status === COMPENSATION_COMPLETED) {
        throw new ConflictException('补偿状态已变化，请刷新后重试');
      }
      if (fresh.status !== COMPENSATION_REFUNDED) {
        await this.wallet.releaseHolds(tx, comp.orderId, now);
        await this.cash.recordOutflow(tx, {
          amountFen: BigInt(fresh.amountFen),
          bizType: CASH_WECHAT_REFUND,
          bizId: `settlement_compensation_${fresh.id.toString()}`,
          occurredAt: now,
        });
        await tx.settlementCompensation.update({
          where: { id: fresh.id },
          data: {
            status: COMPENSATION_REFUNDED,
            refundedAt: now,
            operatorAdminId: adminId,
            updatedAt: now,
          },
        });
      }
    });
    return this.viewOf(
      await this.prisma.settlementCompensation.findUnique({ where: { id: compensationId } }),
    );
  }

  /**
   * 平台补差已下线：钱包份额不足时不再由平台垫钱补足，
   * 统一走订单页的「手动完成结算」（扣冻结/余额到单价对齐上限，缺口写订单备注）。
   */

  private async markCompleted(
    tx: Tx,
    compensationId: bigint,
    adminId: bigint | null,
    now: Date,
  ): Promise<void> {
    await tx.settlementCompensation.update({
      where: { id: compensationId },
      data: {
        status: COMPENSATION_COMPLETED,
        completedAt: now,
        lastTriedAt: now,
        lastError: null,
        operatorAdminId: adminId,
        updatedAt: now,
      },
    });
  }

  private async viewOf(row: Awaited<ReturnType<Tx['settlementCompensation']['findUnique']>>): Promise<CompensationView> {
    if (!row) {
      throw new NotFoundException('补偿记录不存在');
    }
    const order = await this.prisma.order.findUnique({
      where: { id: row.orderId },
      select: { orderNo: true },
    });
    return this.toView(row, order?.orderNo ?? '');
  }

  private toView(
    row: {
      id: bigint;
      orderId: bigint;
      userId: bigint;
      zone: string;
      payNo: string;
      wechatTradeNo: string | null;
      amountFen: number;
      failReason: string;
      status: string;
      retryCount: number;
      lastError: string | null;
      lastTriedAt: Date | null;
      completedAt: Date | null;
      refundedAt: Date | null;
      createdAt: Date;
    },
    orderNo: string,
  ): CompensationView {
    return {
      id: row.id.toString(),
      orderId: row.orderId.toString(),
      orderNo,
      userId: row.userId.toString(),
      zone: row.zone,
      payNo: row.payNo,
      wechatTradeNo: row.wechatTradeNo,
      amountFen: row.amountFen.toString(),
      failReason: row.failReason,
      status: row.status,
      retryCount: row.retryCount,
      lastError: row.lastError,
      lastTriedAt: row.lastTriedAt ? row.lastTriedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      refundedAt: row.refundedAt ? row.refundedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export function compensationRefundNo(compensationId: bigint): string {
  return `SC${compensationId.toString()}`;
}

function readMessage(error: unknown): string {
  const raw =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : '';
  return (raw.trim() || '结算失败').slice(0, 255);
}
