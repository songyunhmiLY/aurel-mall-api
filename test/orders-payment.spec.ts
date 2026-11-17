import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { validate } from 'class-validator';
import { generateKeyPairSync } from 'node:crypto';
import {
  addShanghaiDays,
  startOfNextShanghaiDay,
  startOfShanghaiDay,
} from '../src/common/clock/shanghai-calendar';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { CreateOrderDto } from '../src/modules/orders/dto/create-order.dto';
import type { WechatPayCredentials } from '../src/modules/payments/wechat-pay-settings.service';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  debits,
  loginBuyer,
  marketNode,
  parentChain,
  type Stage2,
} from './support/stage2-harness';

describe('orders and forced payment', () => {
  async function startupProduct(
    stage: ReturnType<typeof buildStage2>,
    name: string,
    stock: number,
    freightFen = 0,
  ) {
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name,
      freightFen,
      stockQuantity: stock,
      status: 'on',
    });
    return created.product;
  }

  async function startupOrder(stage: Stage2, buyer: bigint, name: string) {
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, name, 2);
    return stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
  }

  async function mallProduct(
    stage: ReturnType<typeof buildStage2>,
    name: string,
    priceFen: number,
    pvFen: number,
    stock: number,
    freightFen = 0,
  ) {
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name,
      freightFen,
      priceFen,
      pvFen,
      stockQuantity: stock,
      status: 'on',
    });
    return created.product;
  }

  it('pays a startup order from points then withdrawable, leaves a sub-N remainder, and seats once', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'startup-cover', rootId);
    expect(stage.db.user.rows.find((row) => row.id === buyer)).toMatchObject({
      member: false,
      seated: false,
    });
    const addressId = await addressOf(stage, buyer);
    const first = await startupProduct(stage, '创业甲', 5, 0);
    const second = await startupProduct(stage, '创业乙', 5, 0);
    await credit(stage, buyer, 'points', 3500);
    await credit(stage, buyer, 'consumption', 99999);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [
        { productId: first.id, quantity: 1 },
        { productId: second.id, quantity: 1 },
      ],
    });
    expect(created.goodsTotalFen).toBe(2000);
    expect(created.freightFen).toBe(0);
    expect(created.payAmountFen).toBe(2000);
    expect(created.pvFen).toBe(0);
    expect(created.shipping.detail).toBe('文三路 1 号');

    const paid = await stage.orders.pay(buyer, created.id);
    expect(paid.wechat).toBeNull();
    expect(paid.order.status).toBe('paid');
    expect(paid.order.pointsFen).toBe(2000);
    expect(paid.order.withdrawableFen).toBe(0);
    expect(paid.order.consumptionFen).toBe(0);
    expect(paid.order.wechatFen).toBe(0);
    expect(stage.db.payment.rows).toHaveLength(0);
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(1500n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(0n);
    expect((await stage.wallet.getBalances(buyer)).consumption.balanceFen).toBe(99999n);
    expect(debits(stage.db, buyer, 'points')).toHaveLength(1);
    expect(debits(stage.db, buyer, 'consumption')).toHaveLength(0);
    expect(stage.gateway.createJsapiTransaction).not.toHaveBeenCalled();

    const seat = marketNode(stage.db, buyer);
    expect(seat?.parentUserId).toBe(rootId);
    expect(parentChain(stage.db, buyer)).toEqual([rootId]);
    expect(stage.db.user.rows.find((row) => row.id === buyer)).toMatchObject({
      member: true,
      seated: true,
    });
    expect(stage.hook.events).toHaveLength(1);
    expect(stage.hook.events[0]?.pvFen).toBe(0);

    const again = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: first.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, again.id);
    expect(stage.db.marketTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);
    expect(marketNode(stage.db, buyer)?.parentUserId).toBe(rootId);
    expect(marketNode(stage.db, buyer)?.id).toBe(seat?.id);

    await stage.adminUsers.disable(buyer);
    expect(marketNode(stage.db, buyer)?.id).toBe(seat?.id);
    expect(stage.db.user.rows.find((row) => row.id === buyer)?.member).toBe(true);
    expect(stage.db.user.rows.find((row) => row.id === buyer)?.seated).toBe(true);
  });

  it('does not debit or seat when startup WeChat fails, is cancelled, or times out', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'startup-wechat', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 4);
    await credit(stage, buyer, 'points', 500);
    await credit(stage, buyer, 'withdrawable', 1000);

    const failed = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 3 }],
    });
    const started = await stage.orders.pay(buyer, failed.id);
    expect(started.order.pointsFen).toBe(0);
    expect(started.order.withdrawableFen).toBe(1000);
    expect(started.order.wechatFen).toBe(2000);
    expect(started.wechat?.mode).toBe('sandbox');
    expect(started.wechat?.amountFen).toBe(2000);
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(500n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.frozenFen).toBe(1000n);
    expect(debits(stage.db, buyer, 'withdrawable')).toHaveLength(0);

    await stage.wechatPay.simulateFailure(started.wechat!.payNo);
    expect((await stage.orders.getForUser(buyer, failed.id)).status).toBe('pending_payment');
    expect((await stage.wallet.getBalances(buyer)).withdrawable).toMatchObject({
      balanceFen: 1000n,
      frozenFen: 0n,
    });
    expect(marketNode(stage.db, buyer)).toBeNull();
    expect(stage.hook.events).toHaveLength(0);

    const restarted = await stage.orders.pay(buyer, failed.id);
    await stage.orders.cancel(buyer, failed.id);
    expect((await stage.orders.getForUser(buyer, failed.id)).status).toBe('closed');
    expect((await stage.wallet.getBalances(buyer)).withdrawable.frozenFen).toBe(0n);
    expect(debits(stage.db, buyer, 'withdrawable')).toHaveLength(0);
    // 迟到的成功回调不再直接拒绝：微信钱已扣，登记补偿，等重试复活订单
    await stage.wechatPay.simulateSuccess(restarted.wechat!.payNo);
    expect(stage.db.settlementCompensation.rows).toHaveLength(1);
    expect(stage.db.settlementCompensation.rows[0]).toMatchObject({
      orderId: failed.id,
      status: 'auto_retry',
      failReason: 'order_cancelled',
    });
    expect(marketNode(stage.db, buyer)).toBeNull();
    expect(stage.hook.events).toHaveLength(0);

    const timed = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 2 }],
    });
    await stage.orders.pay(buyer, timed.id);
    await stage.orders.timeout(buyer, timed.id);
    expect((await stage.orders.getForUser(buyer, timed.id)).status).toBe('closed');
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(1000n);
    expect(marketNode(stage.db, buyer)).toBeNull();
    expect(stage.db.user.rows.find((row) => row.id === buyer)?.member).toBe(false);
  });

  it('completes a startup WeChat payment once, then ships it', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'startup-success', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 2, 250);
    await credit(stage, buyer, 'points', 1500);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    expect(created.payAmountFen).toBe(1250);
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.pointsFen).toBe(1000);
    expect(started.order.wechatFen).toBe(250);
    const payNo = started.wechat?.payNo;
    if (!payNo) {
      throw new Error('missing pay no');
    }
    await stage.wechatPay.simulateSuccess(payNo);
    await stage.wechatPay.simulateSuccess(payNo);
    const paid = await stage.orders.getForUser(buyer, created.id);
    expect(paid.status).toBe('paid');
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(500n);
    expect(debits(stage.db, buyer, 'points')).toHaveLength(1);
    expect(stage.db.marketTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);
    expect(stage.hook.events).toHaveLength(1);
    // 重复回调只能记一笔微信实收（需求 §16.1）。
    const orderInflows = stage.db.cashLedgerEntry.rows.filter(
      (row) => row.bizType === 'order_wechat',
    );
    expect(orderInflows).toHaveLength(1);
    expect(orderInflows[0]).toMatchObject({
      direction: 'inflow',
      amountFen: 250n,
      bizId: created.id.toString(),
    });
    expect(stage.db.user.rows.find((row) => row.id === buyer)).toMatchObject({
      member: true,
      seated: true,
    });

    await expect(
      stage.orders.ship(created.id, { courierName: ' ', trackingNumber: 'SF1' }),
    ).rejects.toThrow('快递公司不正确');
    const shipped = await stage.orders.ship(created.id, {
      courierName: '顺丰',
      trackingNumber: 'SF100',
    });
    expect(shipped.status).toBe('shipped');
    expect(shipped.courierName).toBe('顺丰');
    expect(shipped.trackingNumber).toBe('SF100');
    await expect(
      stage.orders.ship(created.id, { courierName: '圆通', trackingNumber: 'YT1' }),
    ).rejects.toThrow('订单已发货');
    const listed = await stage.orders.listAdmin({
      zone: PRODUCT_ZONE_STARTUP,
      status: 'shipped',
      userId: buyer,
      page: 1,
      pageSize: 20,
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe(created.id);

    // 下单时间区间过滤：当天命中，次日之后没有
    const day = startOfShanghaiDay(stage.clock.current);
    const today = await stage.orders.listAdmin({
      placedFrom: day,
      placedUntil: startOfNextShanghaiDay(day),
      page: 1,
      pageSize: 20,
    });
    expect(today.total).toBe(1);
    const tomorrow = await stage.orders.listAdmin({
      placedFrom: startOfNextShanghaiDay(day),
      placedUntil: addShanghaiDays(startOfNextShanghaiDay(day), 1),
      page: 1,
      pageSize: 20,
    });
    expect(tomorrow.total).toBe(0);
  });

  it('rolls back a startup seat when the paid hook fails, and rejects an uninvited buyer', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'hook', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 3);
    await credit(stage, buyer, 'points', 5000);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    stage.hook.fail = true;
    await expect(stage.orders.pay(buyer, created.id)).rejects.toThrow('结算钩子失败');
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('pending_payment');
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(5000n);
    expect(marketNode(stage.db, buyer)).toBeNull();
    expect(stage.db.user.rows.find((row) => row.id === buyer)).toMatchObject({
      member: false,
      seated: false,
    });

    const stranger = await loginBuyer(stage, 'stranger', null);
    const strangerAddress = await addressOf(stage, stranger);
    await expect(
      stage.orders.create(stranger, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId: strangerAddress,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow('缺少邀请关系');
    expect(stage.db.inviteTreeNode.rows.some((row) => row.userId === stranger)).toBe(false);
    expect(marketNode(stage.db, stranger)?.parentUserId).not.toBe(rootId);
  });

  it('rejects a mall order from a non-member and lets a member pay with consumption before withdrawable', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'mall-buyer', rootId);
    const addressId = await addressOf(stage, buyer);
    const gift = await mallProduct(stage, '礼盒', 80, 100, 6, 10);
    const cup = await mallProduct(stage, '杯子', 40, 50, 6, 0);
    await credit(stage, buyer, 'points', 1000);
    await credit(stage, buyer, 'consumption', 1000);

    await expect(
      stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_MALL,
        addressId,
        items: [{ productId: gift.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_MALL,
        addressId,
        items: [{ productId: gift.id, quantity: 1 }],
      }),
    ).rejects.toThrow('非会员不能购买会员商城');
    expect(stage.db.order.rows).toHaveLength(0);

    const startup = await startupProduct(stage, '创业装', 2);
    const entry = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: startup.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, entry.id);
    expect(stage.db.user.rows.find((row) => row.id === buyer)?.member).toBe(true);
    await credit(stage, buyer, 'points', 99999);

    const mall = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [
        { productId: gift.id, quantity: 2 },
        { productId: cup.id, quantity: 3 },
      ],
    });
    expect(mall.goodsTotalFen).toBe(280);
    expect(mall.freightFen).toBe(20);
    expect(mall.payAmountFen).toBe(300);
    expect(mall.pvFen).toBe(350);
    const paid = await stage.orders.pay(buyer, mall.id);
    expect(paid.wechat).toBeNull();
    expect(paid.order.consumptionFen).toBe(300);
    expect(paid.order.pointsFen).toBe(0);
    expect(paid.order.withdrawableFen).toBe(0);
    expect((await stage.wallet.getBalances(buyer)).consumption.balanceFen).toBe(700n);
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(99999n);
    expect(debits(stage.db, buyer, 'points').map((row) => row.bizId)).not.toContain(
      mall.id.toString(),
    );
    expect(stage.hook.events.at(-1)?.pvFen).toBe(350);
    expect(stage.db.marketTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);
    const shipped = await stage.orders.ship(mall.id, {
      courierName: '中通',
      trackingNumber: 'ZT100',
    });
    expect(shipped.status).toBe('shipped');
    expect(shipped.zone).toBe(PRODUCT_ZONE_MALL);
    expect(shipped.trackingNumber).toBe('ZT100');
  });

  it('holds mall balances until WeChat succeeds and restores them on failure', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'mall-split', rootId);
    const addressId = await addressOf(stage, buyer);
    const startup = await startupProduct(stage, '创业装', 1);
    await credit(stage, buyer, 'points', 1000);
    await credit(stage, buyer, 'consumption', 30);
    await credit(stage, buyer, 'withdrawable', 80);
    const entry = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: startup.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, entry.id);

    const goods = await mallProduct(stage, '会员商品', 100, 20, 2);
    await credit(stage, buyer, 'points', 5000);
    const covered = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: goods.id, quantity: 1 }],
    });
    const coveredPay = await stage.orders.pay(buyer, covered.id);
    expect(coveredPay.wechat).toBeNull();
    expect(coveredPay.order.consumptionFen).toBe(30);
    expect(coveredPay.order.withdrawableFen).toBe(70);
    expect((await stage.wallet.getBalances(buyer)).consumption.balanceFen).toBe(0n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(10n);
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(5000n);

    await credit(stage, buyer, 'consumption', 10);
    await credit(stage, buyer, 'withdrawable', 10);
    const partial = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: goods.id, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, partial.id);
    expect(started.order.consumptionFen).toBe(10);
    expect(started.order.withdrawableFen).toBe(20);
    expect(started.order.wechatFen).toBe(70);
    expect(started.wechat?.amountFen).toBe(70);
    expect((await stage.wallet.getBalances(buyer)).consumption.frozenFen).toBe(10n);
    const payNo = started.wechat?.payNo;
    if (!payNo) {
      throw new Error('missing pay no');
    }
    await stage.wechatPay.simulateFailure(payNo);
    expect((await stage.wallet.getBalances(buyer)).consumption).toMatchObject({
      balanceFen: 10n,
      frozenFen: 0n,
    });
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(20n);
    expect((await stage.orders.getForUser(buyer, partial.id)).status).toBe('pending_payment');

    const retry = await stage.orders.pay(buyer, partial.id);
    expect(retry.order.consumptionFen).toBe(10);
    expect(retry.order.withdrawableFen).toBe(20);
    expect(retry.order.wechatFen).toBe(70);
    await stage.wechatPay.simulateSuccess(retry.wechat!.payNo);
    expect((await stage.orders.getForUser(buyer, partial.id)).status).toBe('paid');
    expect((await stage.orders.getForUser(buyer, partial.id)).pvFen).toBe(20);
    expect((await stage.wallet.getBalances(buyer)).consumption.balanceFen).toBe(0n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(0n);
  });

  it('never looks at stock when ordering or paying', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'no-stock', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 1);

    // 库存只留档：数量小于购买量也照常下单，不进任何校验
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 2 }],
    });
    expect(stage.db.order.rows).toHaveLength(1);

    // 支付期间库存被改成 0，也不影响冻结与结算
    await stage.catalog.setStock(product.id, 0);
    await credit(stage, buyer, 'points', 5000);
    // 积分足够时直接扣款完成，不经过微信，也不算库存
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.wechat).toBeNull();
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('paid');
    expect(marketNode(stage.db, buyer)).not.toBeNull();
    // 结算不扣库存，留档数量保持原样
    expect(stage.db.skuStock.rows.find((row) => row.skuId === product.skuId)?.quantity).toBe(0);
  });

  it('rejects a missing address and an address that belongs to someone else', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'addr-buyer', rootId);
    const other = await loginBuyer(stage, 'addr-other', rootId);
    const foreignAddressId = await addressOf(stage, other);
    const product = await startupProduct(stage, '创业装', 2);
    const missing = plainToDto({
      zone: PRODUCT_ZONE_STARTUP,
      items: [{ productId: product.id.toString(), quantity: 1 }],
    });
    const errors = await validate(missing);
    expect(errors.map((error) => error.property)).toContain('addressId');

    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        { zone: PRODUCT_ZONE_STARTUP, items: [{ productId: '1', quantity: 1 }] },
        { type: 'body', metatype: CreateOrderDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    try {
      await pipe.transform(
        { zone: PRODUCT_ZONE_STARTUP, items: [{ productId: '1', quantity: 1 }] },
        { type: 'body', metatype: CreateOrderDto },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).toContain('地址不正确');
    }

    await expect(
      stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId: foreignAddressId,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow('地址不存在');
    expect(stage.db.order.rows.filter((row) => row.userId === buyer)).toHaveLength(0);
  });

  it('fills omitted appId and openid from the wechat_mini identity', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'live-fill', rootId);
    enableLivePrepay(stage);
    const created = await startupOrder(stage, buyer, '补齐');
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.status).toBe('pending_payment');
    expect(started.wechat).toMatchObject({
      mode: 'live',
      appId: 'wx-test-app',
      status: 'pending',
    });
    expect(started.wechat?.paySign).toEqual(expect.any(String));
    expect(stage.gateway.createJsapiTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'wx-test-app',
        openid: 'openid-live-fill',
        amountFen: 1000,
      }),
    );

    const onlyAppId = await startupOrder(stage, buyer, '只带 appId');
    await stage.orders.pay(buyer, onlyAppId.id, { appId: 'wx-test-app' });
    const onlyOpenid = await startupOrder(stage, buyer, '只带 openid');
    await stage.orders.pay(buyer, onlyOpenid.id, { openid: 'openid-live-fill' });
    const blank = await startupOrder(stage, buyer, '空白');
    await stage.orders.pay(buyer, blank.id, { appId: '   ', openid: ' \t ' });
    expect(stage.gateway.createJsapiTransaction).toHaveBeenCalledTimes(4);
    expect(stage.gateway.createJsapiTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: 'wx-test-app', openid: 'openid-live-fill' }),
    );
  });

  it('accepts appId and openid that match the session identity', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'live-match', rootId);
    enableLivePrepay(stage);
    const created = await startupOrder(stage, buyer, '一致');
    const started = await stage.orders.pay(buyer, created.id, {
      appId: 'wx-test-app',
      openid: 'openid-live-match',
    });
    expect(started.wechat?.mode).toBe('live');
    expect(started.wechat?.appId).toBe('wx-test-app');
    expect(stage.gateway.createJsapiTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'wx-test-app', openid: 'openid-live-match' }),
    );

    const again = await stage.orders.pay(buyer, created.id, {
      appId: '  wx-test-app  ',
      openid: ' openid-live-match ',
    });
    expect(again.wechat?.payNo).toBe(started.wechat?.payNo);
    expect(stage.gateway.createJsapiTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects appId or openid that does not match the session identity', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'live-mismatch', rootId);
    enableLivePrepay(stage);
    const wrongApp = await startupOrder(stage, buyer, '错 appId');
    await expectPayRejected(
      stage.orders.pay(buyer, wrongApp.id, {
        appId: 'wx-other',
        openid: 'openid-live-mismatch',
      }),
      'appId 或 openid 与当前微信身份不一致',
    );
    const wrongOpenid = await startupOrder(stage, buyer, '错 openid');
    await expectPayRejected(
      stage.orders.pay(buyer, wrongOpenid.id, {
        appId: 'wx-test-app',
        openid: 'openid-someone-else',
      }),
      'appId 或 openid 与当前微信身份不一致',
    );
    const onlyWrongOpenid = await startupOrder(stage, buyer, '只错 openid');
    await expectPayRejected(
      stage.orders.pay(buyer, onlyWrongOpenid.id, { openid: 'openid-someone-else' }),
      'appId 或 openid 与当前微信身份不一致',
    );
    expect(stage.gateway.createJsapiTransaction).not.toHaveBeenCalled();
    expect((await stage.orders.getForUser(buyer, wrongApp.id)).status).toBe('pending_payment');
  });

  it('rejects live prepay when the user has no wechat_mini identity', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    stage.env.allowPreviewAuth = true;
    const session = await stage.users.loginPreview('preview-payer');
    const buyer = session.user.id;
    await stage.users.bindInviter(buyer, inviteCodeOf(stage, rootId));
    enableLivePrepay(stage);
    const created = await startupOrder(stage, buyer, '预览正式');
    await expectPayRejected(
      stage.orders.pay(buyer, created.id),
      '当前账号没有微信小程序身份，无法微信支付下单',
    );
    await expectPayRejected(
      stage.orders.pay(buyer, created.id, {
        appId: 'wx-test-app',
        openid: 'openid-preview-payer',
      }),
      '当前账号没有微信小程序身份，无法微信支付下单',
    );
    expect(stage.gateway.createJsapiTransaction).not.toHaveBeenCalled();
    expect(stage.db.userIdentity.rows.some((row) => row.provider === 'wechat_mini')).toBe(false);
  });

  it('completes sandbox prepay without appId or openid when merchant materials are absent', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    stage.env.allowPreviewAuth = true;
    const session = await stage.users.loginPreview('preview-sandbox');
    const buyer = session.user.id;
    await stage.users.bindInviter(buyer, inviteCodeOf(stage, rootId));
    const created = await startupOrder(stage, buyer, '沙箱');
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.wechat?.mode).toBe('sandbox');
    expect(started.wechat?.appId).toBeNull();
    expect(started.wechat?.paySign).toBeNull();
    expect(stage.gateway.createJsapiTransaction).not.toHaveBeenCalled();
  });

  it('covers an order from wallet balances without appId or openid when WeChat is configured', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'cover-live', rootId);
    enableLivePrepay(stage);
    await credit(stage, buyer, 'points', 1000);
    const created = await startupOrder(stage, buyer, '账户付清');
    const paid = await stage.orders.pay(buyer, created.id);
    expect(paid.wechat).toBeNull();
    expect(paid.order.status).toBe('paid');
    expect(paid.order.wechatFen).toBe(0);
    expect(stage.gateway.createJsapiTransaction).not.toHaveBeenCalled();
    expect(stage.db.payment.rows).toHaveLength(0);
  });
});

function plainToDto(value: object): CreateOrderDto {
  return Object.assign(new CreateOrderDto(), value);
}

function enableLivePrepay(stage: Stage2): void {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials: WechatPayCredentials = {
    merchantId: '1900000109',
    apiV3Key: '0123456789abcdef0123456789abcdef',
    certificatePem: 'test-certificate',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    serialNumber: 'ABC',
  };
  stage.paySettings.credentials = credentials;
  stage.env.wechatPayNotifyUrl = 'https://mall.example.com/api/v1/payments/wechat/notify';
  stage.gateway.createJsapiTransaction.mockResolvedValue({ prepayId: 'prepay-live' });
}

function inviteCodeOf(stage: Stage2, userId: bigint): string {
  const code = stage.db.user.rows.find((row) => row.id === userId)?.inviteCode;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('missing invite code');
  }
  return code;
}

async function expectPayRejected(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toMatchObject({ message });
    return;
  }
  throw new Error(`expected 400: ${message}`);
}
