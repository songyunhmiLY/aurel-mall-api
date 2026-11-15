import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { PRODUCT_ZONE_MALL } from '../src/modules/catalog/catalog.constants';
import { OrderTimeoutService } from '../src/modules/orders/order-timeout.service';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  loginBuyer,
  type Stage2,
} from './support/stage2-harness';

function timeoutsOf(stage: Stage2): OrderTimeoutService {
  return new OrderTimeoutService(
    stage.db as unknown as PrismaService,
    stage.clock as unknown as ClockService,
    stage.wallet,
    stage.env,
  );
}

function advance(stage: Stage2, minutes: number): void {
  stage.clock.current = new Date(stage.clock.current.getTime() + minutes * 60_000);
}

function orderRow(stage: Stage2, orderId: bigint) {
  const row = stage.db.order.rows.find((item) => item.id === orderId);
  if (!row) {
    throw new Error('missing order');
  }
  return row;
}

function heldOf(stage: Stage2, orderId: bigint) {
  return stage.db.walletHold.rows.filter(
    (row) => row.orderId === orderId && row.status === 'held',
  );
}

function frozenConsumption(stage: Stage2, userId: bigint): number {
  const account = stage.db.walletAccount.rows.find(
    (row) => row.userId === userId && row.walletType === 'consumption',
  );
  return account ? Number(account.frozenFen) : 0;
}

function paymentOf(stage: Stage2, orderId: bigint) {
  return stage.db.payment.rows.filter((row) => row.orderId === orderId).at(-1);
}

describe('order timeout close', () => {
  async function pendingOrder(stage: Stage2, name: string) {
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, name, rootId);
    // 商城订单：消费金可以付任意余数，点过支付即冻结这部分额度
    const buyerRow = stage.db.user.rows.find((row) => row.id === buyer);
    if (!buyerRow) {
      throw new Error('missing buyer');
    }
    buyerRow.member = true;
    await credit(stage, buyer, 'consumption', 300);
    const addressId = await addressOf(stage, buyer);
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: `${name}-商品`,
      freightFen: 0,
      priceFen: 1000,
      pvFen: 1000,
      stockQuantity: 10,
      status: 'on',
    });
    const order = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: created.product.id, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, order.id);
    expect(started.wechat?.payNo).toBeTruthy();
    return { buyer, orderId: order.id };
  }

  it('closes an unpaid order after the window, releasing holds and failing the payment', async () => {
    const stage = buildStage2();
    const { buyer, orderId } = await pendingOrder(stage, 'timeout-close');
    const timeouts = timeoutsOf(stage);

    // 点过支付即冻结钱包份额，这正是超时关单要解开的占用
    expect(heldOf(stage, orderId).length).toBeGreaterThan(0);
    expect(frozenConsumption(stage, buyer)).toBeGreaterThan(0);

    advance(stage, 10);
    expect(await timeouts.closeExpired()).toBe(0);
    expect(orderRow(stage, orderId).status).toBe('pending_payment');

    advance(stage, 6);
    expect(await timeouts.closeExpired()).toBe(1);
    expect(orderRow(stage, orderId).status).toBe('closed');
    expect(orderRow(stage, orderId).closedAt).toBeTruthy();
    expect(heldOf(stage, orderId)).toHaveLength(0);
    expect(frozenConsumption(stage, buyer)).toBe(0);
    expect(paymentOf(stage, orderId)).toMatchObject({ status: 'failed', activeSlot: null });

    // 已关闭的单不会再被扫到
    advance(stage, 60);
    expect(await timeouts.closeExpired()).toBe(0);
  });

  it('never closes an order that has a compensation record', async () => {
    const stage = buildStage2();
    const { orderId } = await pendingOrder(stage, 'timeout-compensation');

    // 微信已扣款但库存不足，结算事务回滚：订单仍是待支付，holds 仍冻结，补偿等待人工处理
    const orderItems = stage.db.orderItem.rows.filter((row) => row.orderId === orderId);
    stage.db.skuStock.update({
      where: { skuId: orderItems[0]!.skuId },
      data: { quantity: 0 },
    });
    const payment = paymentOf(stage, orderId)!;
    await stage.wechatPay.simulateSuccess(String(payment.payNo));
    expect(orderRow(stage, orderId).status).toBe('pending_payment');
    expect(stage.db.settlementCompensation.rows).toHaveLength(1);
    expect(heldOf(stage, orderId).length).toBeGreaterThan(0);

    advance(stage, 120);
    expect(await timeoutsOf(stage).closeExpired()).toBe(0);
    expect(orderRow(stage, orderId).status).toBe('pending_payment');
    expect(heldOf(stage, orderId).length).toBeGreaterThan(0);
  });

  it('leaves paid orders alone and does nothing when the window is disabled', async () => {
    const stage = buildStage2();
    const { orderId } = await pendingOrder(stage, 'timeout-paid');
    const payment = paymentOf(stage, orderId)!;
    await stage.wechatPay.simulateSuccess(String(payment.payNo));
    expect(orderRow(stage, orderId).status).toBe('paid');

    advance(stage, 120);
    expect(await timeoutsOf(stage).closeExpired()).toBe(0);
    expect(orderRow(stage, orderId).status).toBe('paid');

    stage.env.orderPaymentTimeoutMinutes = 0;
    expect(await timeoutsOf(stage).closeExpired()).toBe(0);
  });
});
