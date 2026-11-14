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
import { ORDER_PAID, ORDER_PENDING_PAYMENT, ORDER_SHIPPED } from './order.constants';
import { PendingSettlementHook } from './order-paid.hook';

type Tx = Prisma.TransactionClient;

/** 这一单的钱从哪来。只有微信实收才进现金流水，余额抵扣是平台内部划转。 */
export type PaidBy = 'wechat' | 'wallet';

/**
 * 微信支付进入终态，或账户已足够支付时，完成或回滚订单。
 * 扣款、扣库存、入座和订单状态在同一个事务里。
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
    await this.collect(tx, order.id, order.userId, order, now);
    await this.deductStock(tx, order.id, now);
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      await this.trees.seat(tx, order.userId, now);
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

  private async deductStock(tx: Tx, orderId: bigint, now: Date): Promise<void> {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const ordered = [...items].sort((left, right) =>
      left.skuId < right.skuId ? -1 : left.skuId > right.skuId ? 1 : 0,
    );
    for (const item of ordered) {
      await tx.$queryRaw`
        SELECT id FROM sku_stocks WHERE sku_id = ${item.skuId} FOR UPDATE
      `;
      const stock = await tx.skuStock.findUnique({ where: { skuId: item.skuId } });
      if (!stock || stock.quantity < item.quantity) {
        throw new ConflictException('库存不足');
      }
      await tx.skuStock.update({
        where: { skuId: item.skuId },
        data: { quantity: stock.quantity - item.quantity, updatedAt: now },
      });
    }
  }
}
