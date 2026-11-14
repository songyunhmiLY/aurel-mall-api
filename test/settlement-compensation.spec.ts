import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import {
  WALLET_COMPENSATION_SUBSIDY,
} from '../src/modules/orders/settlement-compensation.constants';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  loginBuyer,
  marketNode,
  stockOf,
  type Stage2,
} from './support/stage2-harness';

describe('settlement compensation', () => {
  async function startupProduct(stage: Stage2, name: string, stock: number) {
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name,
      freightFen: 0,
      stockQuantity: stock,
      status: 'on',
    });
    return created.product;
  }

  function compRows(stage: Stage2) {
    return stage.db.settlementCompensation.rows;
  }

  function orderRow(stage: Stage2, orderId: bigint) {
    const row = stage.db.order.rows.find((item) => item.id === orderId);
    if (!row) {
      throw new Error('missing order');
    }
    return row;
  }

  function cashRows(stage: Stage2) {
    return stage.db.cashLedgerEntry.rows;
  }

  it('registers a compensation when stock runs out, then finishes after restocking', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'comp-stock', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业补偿甲', 1);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.wechat?.payNo).toBeTruthy();

    // 支付等待期间库存被别的订单买光（结算时才扣库存）
    stage.db.skuStock.update({
      where: { skuId: product.skuId },
      data: { quantity: 0 },
    });
    const paid = await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(paid.status).toBe('success');
    expect(orderRow(stage, created.id).status).toBe('pending_payment');

    const rows = compRows(stage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: created.id,
      payNo: started.wechat!.payNo,
      amountFen: 1000,
      status: 'auto_retry',
      failReason: 'stock_insufficient',
    });
    expect(rows[0]!.lastError).toBe('库存不足');

    // 微信实收已入账，对账不会缺这一笔
    expect(
      cashRows(stage).filter((row) => row.bizType === 'order_wechat' && row.direction === 'inflow'),
    ).toHaveLength(1);

    // 有活跃补偿单时不能再发起支付，防止二次扣款
    await expect(stage.orders.pay(buyer, created.id)).rejects.toBeInstanceOf(ConflictException);

    // 重复回调幂等：不产生新补偿、不重复入账
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(compRows(stage)).toHaveLength(1);
    expect(cashRows(stage).filter((row) => row.bizType === 'order_wechat')).toHaveLength(1);

    // 人工补货后点「继续结算」
    stage.db.skuStock.update({ where: { skuId: product.skuId }, data: { quantity: 5 } });
    const view = await stage.compensations.retryOne(rows[0]!.id);
    expect(view.status).toBe('completed');
    expect(orderRow(stage, created.id).status).toBe('paid');
    expect(stockOf(stage.db, product.skuId)).toBe(4);
    expect(marketNode(stage.db, buyer)?.parentUserId).toBe(rootId);
    expect(
      cashRows(stage).filter((row) => row.bizType === 'order_wechat' && row.direction === 'inflow'),
    ).toHaveLength(1);
    expect(stage.hook.events).toHaveLength(1);
  });

  it('revives a closed order that WeChat already charged, via the scheduled retry', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'comp-cancelled', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业补偿乙', 4);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    // 用户在第 29 分 59 秒付款，超时取消任务先一步关单
    stage.db.order.update({
      where: { id: created.id },
      data: { status: 'closed', closedAt: stage.clock.current },
    });
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);

    expect(compRows(stage)).toHaveLength(1);
    expect(compRows(stage)[0]).toMatchObject({
      status: 'auto_retry',
      failReason: 'order_cancelled',
    });
    expect(orderRow(stage, created.id).status).toBe('closed');

    const attempted = await stage.compensations.runDue();
    expect(attempted).toBe(1);
    expect(orderRow(stage, created.id).status).toBe('paid');
    expect(compRows(stage)[0]!.status).toBe('completed');
    expect(stage.db.payment.rows.find((row) => row.payNo === started.wechat!.payNo)?.status).toBe(
      'success',
    );
  });

  it('moves to awaiting_operation on wallet shortfall and finishes after platform subsidy', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'comp-shortfall', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业补偿丙', 4);
    await credit(stage, buyer, 'points', 1000);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 2 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.pointsFen).toBe(1000);
    expect(started.order.wechatFen).toBe(1000);
    stage.db.skuStock.update({ where: { skuId: product.skuId }, data: { quantity: 0 } });
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(compRows(stage)).toHaveLength(1);

    // 模拟冻结被释放后余额又被花掉：补偿重试收不回钱包份额
    await stage.db.$transaction(async (tx) => {
      await stage.wallet.releaseHolds(
        tx as unknown as Prisma.TransactionClient,
        created.id,
        stage.clock.current,
      );
    });
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'points' },
      data: { balanceFen: 0n, frozenFen: 0n },
    });

    const short = await stage.compensations.retryOne(compRows(stage)[0]!.id);
    expect(short.status).toBe('awaiting_operation');
    expect(short.failReason).toBe('wallet_shortfall');
    expect(orderRow(stage, created.id).status).toBe('pending_payment');

    // 平台补差按订单拆分份额补足（创业专区：积分+可提现），补货后继续结算
    stage.db.skuStock.update({ where: { skuId: product.skuId }, data: { quantity: 2 } });
    const done = await stage.compensations.retryOne(compRows(stage)[0]!.id, {
      subsidize: true,
      adminId: 1n,
    });
    expect(done.status).toBe('completed');
    expect(orderRow(stage, created.id).status).toBe('paid');
    const balances = await stage.wallet.getBalances(buyer);
    expect(balances.points.balanceFen).toBe(0n);
    const subsidy = stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === buyer && row.bizType === WALLET_COMPENSATION_SUBSIDY,
    );
    expect(subsidy).toHaveLength(1);
    expect(compRows(stage)[0]!.operatorAdminId).toBe(1n);
  });

  it('refunds the wechat portion and releases holds when the admin chooses refund', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'comp-refund', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业补偿丁', 4);
    await credit(stage, buyer, 'withdrawable', 1000);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 2 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.withdrawableFen).toBe(1000);
    stage.db.skuStock.update({ where: { skuId: product.skuId }, data: { quantity: 0 } });
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);

    const view = await stage.compensations.refund(compRows(stage)[0]!.id, 9n);
    expect(view.status).toBe('refunded');
    expect(compRows(stage)[0]).toMatchObject({ status: 'refunded', operatorAdminId: 9n });
    // 可提现冻结份额解冻，钱回到账户；微信实收记一笔流出
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(1000n);
    expect(
      cashRows(stage).filter(
        (row) => row.bizType === 'wechat_refund' && row.direction === 'outflow',
      ),
    ).toHaveLength(1);
    expect(orderRow(stage, created.id).status).toBe('pending_payment');
  });
});
