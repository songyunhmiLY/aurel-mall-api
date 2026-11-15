import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { WECHAT_PAY_CHANNEL } from '../payments/wechat-pay.constants';
import { WalletService } from '../wallet/wallet.service';
import { ORDER_CLOSED, ORDER_PENDING_PAYMENT } from './order.constants';

/** 单次扫描上限。一次 tick 关太多单会拉长事务链，宁可分几个 tick 关完。 */
const SCAN_LIMIT = 50;
const PAYMENT_PENDING = 'pending';
const PAYMENT_SUCCESS = 'success';
const PAYMENT_FAILED = 'failed';

/**
 * 待支付订单的超时关单。
 *
 * 为什么需要它：下单本身不占库存也不冻结钱包，冻结发生在用户点「支付」时（`prepareSplit` 建 holds）。
 * 用户点过支付又放弃，这笔冻结会一直挂着；订单也会长期停在「待支付」，占着用户列表。
 * 之前只有前端手动触发的 `POST /orders/:id/timeout`，用户关掉小程序就没人关单。
 *
 * 与结算补偿的边界（关键）：微信已扣款、本地结算事务失败时，订单状态仍是「待支付」，
 * 此时 holds 仍处于冻结态，是补偿重试能继续结算的前提。所以只要该订单存在补偿记录
 * （不论状态），一律不关单——关掉会释放 holds，补偿重试就退化成「钱包份额不足」。
 */
@Injectable()
export class OrderTimeoutService {
  private readonly logger = new Logger(OrderTimeoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** 定时任务入口。返回本次实际关闭的订单数。时长为 0 时不做任何事。 */
  async closeExpired(limit = SCAN_LIMIT): Promise<number> {
    const minutes = this.env.orderPaymentTimeoutMinutes;
    if (minutes <= 0) {
      return 0;
    }
    const now = await this.clock.now();
    const deadline = this.clock.instant(now.getTime() - minutes * 60_000);
    const candidates = await this.prisma.order.findMany({
      where: { status: ORDER_PENDING_PAYMENT, placedAt: { lt: deadline } },
      orderBy: { placedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let closed = 0;
    for (const candidate of candidates) {
      try {
        if (await this.closeOne(candidate.id, deadline, now)) {
          closed += 1;
        }
      } catch (error) {
        // 单笔失败不影响其它订单：下一轮 tick 会再试。
        this.logger.warn(`超时关单失败 order=${candidate.id.toString()}: ${String(error)}`);
      }
    }
    return closed;
  }

  private async closeOne(orderId: bigint, deadline: Date, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== ORDER_PENDING_PAYMENT) {
        return false;
      }
      // 锁内复核：扫描后到拿到锁之间订单可能已被支付或手动关闭。
      if (order.placedAt >= deadline) {
        return false;
      }
      const compensation = await tx.settlementCompensation.findFirst({
        where: { orderId },
        select: { id: true },
      });
      if (compensation) {
        return false;
      }
      const succeeded = await tx.payment.findFirst({
        where: { orderId, channel: WECHAT_PAY_CHANNEL, status: PAYMENT_SUCCESS },
        select: { id: true },
      });
      if (succeeded) {
        return false;
      }
      await this.wallet.releaseHolds(tx, orderId, now);
      const pending = await tx.payment.findFirst({
        where: { orderId, channel: WECHAT_PAY_CHANNEL, status: PAYMENT_PENDING },
      });
      if (pending) {
        await tx.payment.update({
          where: { id: pending.id },
          data: { status: PAYMENT_FAILED, activeSlot: null, updatedAt: now },
        });
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: ORDER_CLOSED, closedAt: now, updatedAt: now },
      });
      return true;
    });
  }
}
