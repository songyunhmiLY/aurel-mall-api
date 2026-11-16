import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { WECHAT_PAY_CHANNEL } from '../payments/wechat-pay.constants';
import { TreesService } from '../rewards/trees/trees.service';
import { CashLedgerService } from '../wallet/cash-ledger.service';
import {
  CASH_ORDER_WECHAT,
  HOLD_HELD,
  WALLET_CONSUMPTION,
  WALLET_POINTS,
  WALLET_WITHDRAWABLE,
  type WalletType,
} from '../wallet/wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import { ORDER_CLOSED, ORDER_PAID, ORDER_PENDING_PAYMENT, ORDER_SHIPPED } from './order.constants';
import {
  COMPENSATION_AUTO_RETRY,
  COMPENSATION_AWAITING_OPERATION,
  COMPENSATION_REASON_SEAT,
  COMPENSATION_REASON_TRANSIENT,
  COMPENSATION_REASON_WALLET,
} from './settlement-compensation.constants';
import { PendingSettlementHook } from './order-paid.hook';

type Tx = Prisma.TransactionClient;

/** 钱包份额收不回来（冻结已释放且余额不够）。补偿机制按这个类型转入待人工。 */
export class WalletShortfallError extends Error {
  constructor(cause: unknown) {
    super('钱包份额不足');
    this.name = 'WalletShortfallError';
    this.cause = cause;
  }
}

/** 入座阶段失败（市场树无法容纳、缺邀请关系等）。重试可能换到空位，归自动重试。 */
export class SeatPlacementError extends Error {
  constructor(cause: unknown) {
    super('入座失败');
    this.name = 'SeatPlacementError';
    this.cause = cause;
  }
}

/** 这一单的钱从哪来。只有微信实收才进现金流水，余额抵扣是平台内部划转。 */
export type PaidBy = 'wechat' | 'wallet';

/** 结算失败 → 补偿记录的 (状态, 失败原因) 分类。登记时和重试时共用同一份。 */
export function classifySettlementError(error: unknown): { status: string; reason: string } {
  if (error instanceof WalletShortfallError) {
    return { status: COMPENSATION_AWAITING_OPERATION, reason: COMPENSATION_REASON_WALLET };
  }
  if (error instanceof SeatPlacementError) {
    return { status: COMPENSATION_AUTO_RETRY, reason: COMPENSATION_REASON_SEAT };
  }
  return { status: COMPENSATION_AUTO_RETRY, reason: COMPENSATION_REASON_TRANSIENT };
}

/**
 * 微信支付进入终态，或账户已足够支付时，完成或回滚订单。
 * 扣款、入座和订单状态在同一个事务里。库存不参与结算。
 */
@Injectable()
export class OrderPaymentSettler {
  constructor(
    private readonly wallet: WalletService,
    private readonly trees: TreesService,
    private readonly hook: PendingSettlementHook,
    private readonly cash: CashLedgerService,
  ) {}

  async settleWechatSuccess(tx: Tx, orderId: bigint, now: Date): Promise<string> {
    const otherPending = await tx.payment.findFirst({
      where: { orderId, channel: WECHAT_PAY_CHANNEL, status: 'pending' },
    });
    if (otherPending) {
      throw new ConflictException('订单有另一笔待支付');
    }
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (order.status === ORDER_PAID || order.status === ORDER_SHIPPED) {
      return order.status;
    }
    if (order.status !== ORDER_PENDING_PAYMENT) {
      throw new ConflictException('订单不在待支付状态');
    }
    await this.finish(tx, order.id, now, 'wechat');
    return ORDER_PAID;
  }

  async releaseWechatFailure(tx: Tx, orderId: bigint, now: Date): Promise<void> {
    await this.wallet.releaseHolds(tx, orderId, now);
  }

  async finish(tx: Tx, orderId: bigint, now: Date, paidBy: PaidBy): Promise<void> {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (order.status !== ORDER_PENDING_PAYMENT) {
      throw new ConflictException('订单不在待支付状态');
    }
    await this.doFinish(tx, order.id, now, paidBy);
  }

  /** 订单已是终态（已支付/已发货）时返回 false，不需要再结算。 */
  orderAlreadySettled(status: string): boolean {
    return status === ORDER_PAID || status === ORDER_SHIPPED;
  }

  /**
   * 补偿路径的结算。除待支付外还接受已关闭的订单——
   * 微信钱已到手、只是被超时取消任务抢先关单的场景，直接复活并完成。
   */
  async finishForCompensation(tx: Tx, orderId: bigint, now: Date): Promise<void> {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    if (this.orderAlreadySettled(order.status)) {
      return;
    }
    if (order.status !== ORDER_PENDING_PAYMENT && order.status !== ORDER_CLOSED) {
      throw new ConflictException('订单不在待支付状态');
    }
    await this.doFinish(tx, order.id, now, 'wechat');
  }

  private async doFinish(tx: Tx, orderId: bigint, now: Date, paidBy: PaidBy): Promise<void> {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    try {
      await this.collect(tx, order.id, order.userId, order, now);
    } catch (error) {
      if (error instanceof ConflictException && error.message === '余额不足') {
        throw new WalletShortfallError(error);
      }
      throw error;
    }
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      try {
        await this.trees.seat(tx, order.userId, now);
      } catch (error) {
        if (error instanceof ConflictException && error.message === '余额不足') {
          throw error;
        }
        throw new SeatPlacementError(error);
      }
    }
    await tx.order.update({
      where: { id: order.id },
      data: { status: ORDER_PAID, paidAt: now, updatedAt: now },
    });
    if (paidBy === 'wechat') {
      // 需求 §16.1：订单微信实收必须进资金流水，不得漏记。
      // 幂等靠 (direction, bizType, bizId)，重复回调不会重复记账。
      await this.cash.recordInflow(tx, {
        amountFen: BigInt(order.wechatFen),
        bizType: CASH_ORDER_WECHAT,
        bizId: order.id.toString(),
        occurredAt: now,
      });
    }
    await this.hook.afterOrderPaid({
      tx,
      orderId: order.id,
      userId: order.userId,
      zone: order.zone,
      payAmountFen: order.payAmountFen,
      pvFen: order.pvFen,
      paidAt: now,
    });
  }

  private async collect(
    tx: Tx,
    orderId: bigint,
    userId: bigint,
    order: {
      pointsFen: number;
      withdrawableFen: number;
      consumptionFen: number;
    },
    now: Date,
  ): Promise<void> {
    const held = await tx.walletHold.findFirst({ where: { orderId, status: HOLD_HELD } });
    if (held) {
      await this.wallet.captureHolds(tx, orderId, now);
      return;
    }
    await this.wallet.lockAll(tx, userId, now);
    const portions: Array<[WalletType, number]> = [
      [WALLET_CONSUMPTION, order.consumptionFen],
      [WALLET_POINTS, order.pointsFen],
      [WALLET_WITHDRAWABLE, order.withdrawableFen],
    ];
    for (const [walletType, amount] of portions) {
      if (amount > 0) {
        await this.wallet.debit(tx, userId, walletType, BigInt(amount), orderId, now);
      }
    }
  }

}
