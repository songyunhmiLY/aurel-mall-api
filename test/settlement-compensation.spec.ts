import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  loginBuyer,
  marketNode,
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

  it('registers a compensation when settlement fails, then finishes after the balance is restored', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'comp-shortfall', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业补偿甲', 4);
    await credit(stage, buyer, 'points', 1000);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 2 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.wechat?.payNo).toBeTruthy();
    expect(started.order.pointsFen).toBe(1000);
    expect(started.order.wechatFen).toBe(1000);

    // 冻结还在，但账户余额被别处扣走：结算时收不回这副份额
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'points' },
      data: { balanceFen: 0n },
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
      failReason: 'wallet_shortfall',
    });

    // 订单视图带出结算异常标记，供两端显示黄色「！」
    const flagged = await stage.orders.getForUser(buyer, created.id);
    expect(flagged.settlementPending).toBe(true);
    expect(flagged.compensationId).toBe(rows[0]!.id.toString());
    expect(rows[0]!.lastError).toBe('钱包份额不足');

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

    // 第一次重试判定为「重试也没用」：转待人工，不再空转
    const flipped = await stage.compensations.retryOne(rows[0]!.id);
    expect(flipped.status).toBe('awaiting_operation');

    // 把被花掉的份额补回账户后点「继续结算」
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'points' },
      data: { balanceFen: 1000n },
    });
    const view = await stage.compensations.retryOne(rows[0]!.id);
    expect(view.status).toBe('completed');
    expect(orderRow(stage, created.id).status).toBe('paid');

    // 结算完成后标记自动消失
    const restored = await stage.orders.getForUser(buyer, created.id);
    expect(restored.settlementPending).toBe(false);
    expect(restored.compensationId).toBeNull();
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

  it('moves to awaiting_operation on wallet shortfall and completes via forced settlement', async () => {
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
    // 超时关单抢先：钱已收、单已关，补偿先进入自动重试
    stage.db.order.update({
      where: { id: created.id },
      data: { status: 'closed', closedAt: stage.clock.current },
    });
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
    expect(orderRow(stage, created.id).status).toBe('closed');

    // 补差已下线：钱包份额不足时通过订单页「手动完成结算」兜底（扣到空、缺口写备注）
    const done = await stage.compensations.forceComplete(compRows(stage)[0]!.id, 1n);
    expect(done.view.status).toBe('completed');
    expect(done.note).toContain('积分');
    expect(orderRow(stage, created.id).status).toBe('paid');
    const balances = await stage.wallet.getBalances(buyer);
    expect(balances.points.balanceFen).toBe(0n);
    const subsidy = stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === buyer && row.bizType === 'compensation_subsidy',
    );
    expect(subsidy).toHaveLength(0);
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
    stage.db.order.update({
      where: { id: created.id },
      data: { status: 'closed', closedAt: stage.clock.current },
    });
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
    expect(orderRow(stage, created.id).status).toBe('closed');
  });

  it('force-completes a mall order, deducting the shortfall to empty', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'force-mall', rootId);
    const addressId = await addressOf(stage, buyer);

    // 先买创业装入座成为会员，才有资格买商城
    const entry = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: (await startupProduct(stage, '创业装F', 1)).id, quantity: 1 }],
    });
    const entryPay = await stage.orders.pay(buyer, entry.id);
    if (entryPay.wechat) {
      await stage.wechatPay.simulateSuccess(entryPay.wechat.payNo);
    }
    expect(marketNode(stage.db, buyer)).not.toBeNull();

    const mall = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '会员商品F',
      freightFen: 0,
      priceFen: 10000,
      pvFen: 20,
      stockQuantity: 2,
      status: 'on',
    });
    await credit(stage, buyer, 'consumption', 6000);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: mall.product.id, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.consumptionFen).toBe(6000);
    expect(started.order.wechatFen).toBe(4000);

    // 余额被扣走一部分：结算失败，补偿挂起
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'consumption' },
      data: { balanceFen: 2000n },
    });
    const paid = await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(paid.status).toBe('success');
    expect(orderRow(stage, created.id).status).toBe('pending_payment');
    expect((await stage.orders.getForUser(buyer, created.id)).settlementPending).toBe(true);

    // 人工完成结算：扣到空、缺口写备注、订单恢复已支付、补偿关闭
    const result = await stage.compensations.forceComplete(created.id, 7n);
    expect(result.view.status).toBe('completed');
    expect(result.note).toContain('消费金缺口 ¥40.00');
    expect(orderRow(stage, created.id).status).toBe('paid');
    expect(orderRow(stage, created.id).remark).toContain('消费金缺口 ¥40.00');

    const balances = await stage.wallet.getBalances(buyer);
    expect(balances.consumption.balanceFen).toBe(0n);
    expect(balances.consumption.frozenFen).toBe(0n);

    const restored = await stage.orders.getForUser(buyer, created.id);
    expect(restored.settlementPending).toBe(false);
    expect(restored.compensationId).toBeNull();
    expect(restored.remark).toContain('消费金缺口');
  });

  it('force-completes a startup order and seats the buyer', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'force-seat', rootId);
    const addressId = await addressOf(stage, buyer);
    await credit(stage, buyer, 'points', 1000);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: (await startupProduct(stage, '创业装G', 1)).id, quantity: 2 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.pointsFen).toBe(1000);

    // 积分余额被清走：结算失败，补偿挂起，买家还没入座
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'points' },
      data: { balanceFen: 0n },
    });
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(orderRow(stage, created.id).status).toBe('pending_payment');
    expect(marketNode(stage.db, buyer)).toBeNull();

    const result = await stage.compensations.forceComplete(created.id, 7n);
    expect(result.view.status).toBe('completed');
    expect(result.note).toContain('入座完成');
    expect(orderRow(stage, created.id).status).toBe('paid');
    expect(marketNode(stage.db, buyer)?.parentUserId).toBe(rootId);
  });

  it('force-completes a startup order without touching the sub-unit remainder', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'force-align', rootId);
    const addressId = await addressOf(stage, buyer);
    await credit(stage, buyer, 'points', 1000);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: (await startupProduct(stage, '创业装H', 1)).id, quantity: 2 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.pointsFen).toBe(1000);

    // 余额只剩不足一个单价的零头：按单价对齐后一分都扣不了，零头必须留下
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'points' },
      data: { balanceFen: 500n },
    });
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(orderRow(stage, created.id).status).toBe('pending_payment');

    const result = await stage.compensations.forceComplete(created.id, 7n);
    expect(result.view.status).toBe('completed');
    expect(result.note).toContain('积分缺口 ¥10.00');
    expect(result.note).toContain('零头留在账户');
    expect(orderRow(stage, created.id).status).toBe('paid');

    const balances = await stage.wallet.getBalances(buyer);
    expect(balances.points.balanceFen).toBe(500n);
    expect(balances.points.frozenFen).toBe(0n);
  });

  it('force-completes a startup order up to the unit-aligned limit', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'force-align-part', rootId);
    const addressId = await addressOf(stage, buyer);
    await credit(stage, buyer, 'points', 2000);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: (await startupProduct(stage, '创业装I', 1)).id, quantity: 3 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.pointsFen).toBe(2000);

    // 余额 1500：能扣 1 个单价（1000），剩下 500 是零头，不扣
    stage.db.walletAccount.update({
      where: { userId: buyer, walletType: 'points' },
      data: { balanceFen: 1500n },
    });
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);
    expect(orderRow(stage, created.id).status).toBe('pending_payment');

    const result = await stage.compensations.forceComplete(created.id, 7n);
    expect(result.view.status).toBe('completed');
    expect(result.note).toContain('积分缺口 ¥10.00');
    expect(orderRow(stage, created.id).status).toBe('paid');

    const balances = await stage.wallet.getBalances(buyer);
    expect(balances.points.balanceFen).toBe(500n);
  });
});
