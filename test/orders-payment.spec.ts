import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { CreateOrderDto } from '../src/modules/orders/dto/create-order.dto';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  debits,
  loginBuyer,
  marketNode,
  parentChain,
  stockOf,
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
    expect(stockOf(stage.db, first.skuId)).toBe(4);

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
    expect(stockOf(stage.db, product.skuId)).toBe(4);

    const restarted = await stage.orders.pay(buyer, failed.id);
    await stage.orders.cancel(buyer, failed.id);
    expect((await stage.orders.getForUser(buyer, failed.id)).status).toBe('closed');
    expect((await stage.wallet.getBalances(buyer)).withdrawable.frozenFen).toBe(0n);
    expect(debits(stage.db, buyer, 'withdrawable')).toHaveLength(0);
    await expect(stage.wechatPay.simulateSuccess(restarted.wechat!.payNo)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(marketNode(stage.db, buyer)).toBeNull();

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
    expect(stockOf(stage.db, product.skuId)).toBe(1);
    expect(stage.db.marketTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);
    expect(stage.hook.events).toHaveLength(1);
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
    expect(stockOf(stage.db, product.skuId)).toBe(3);

    const stranger = await loginBuyer(stage, 'stranger', null);
    const strangerAddress = await addressOf(stage, stranger);
    await expect(
      stage.orders.create(stranger, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId: strangerAddress,
        items: [{ productId: product.id, quantity: 1 }],
      }),
    ).rejects.toThrow('缺少邀请关系');
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
    expect(stockOf(stage.db, gift.skuId)).toBe(4);
    expect(stockOf(stage.db, cup.skuId)).toBe(3);
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
    expect(stockOf(stage.db, goods.skuId)).toBe(1);

    const retry = await stage.orders.pay(buyer, partial.id);
    expect(retry.order.consumptionFen).toBe(10);
    expect(retry.order.withdrawableFen).toBe(20);
    expect(retry.order.wechatFen).toBe(70);
    await stage.wechatPay.simulateSuccess(retry.wechat!.payNo);
    expect((await stage.orders.getForUser(buyer, partial.id)).status).toBe('paid');
    expect((await stage.orders.getForUser(buyer, partial.id)).pvFen).toBe(20);
    expect((await stage.wallet.getBalances(buyer)).consumption.balanceFen).toBe(0n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(0n);
    expect(stockOf(stage.db, goods.skuId)).toBe(0);
  });

  it('rejects an order or a payment when stock is short', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'stock', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 1);
    await expect(
      stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId,
        items: [{ productId: product.id, quantity: 2 }],
      }),
    ).rejects.toThrow('库存不足');
    expect(stage.db.order.rows).toHaveLength(0);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await stage.catalog.setStock(product.id, 0);
    await credit(stage, buyer, 'points', 5000);
    await expect(stage.orders.pay(buyer, created.id)).rejects.toThrow('库存不足');
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('pending_payment');
    expect((await stage.wallet.getBalances(buyer)).points.balanceFen).toBe(5000n);
    expect(marketNode(stage.db, buyer)).toBeNull();
    await expect(
      stage.orders.ship(created.id, { courierName: '顺丰', trackingNumber: 'SF1' }),
    ).rejects.toThrow('只有已支付的订单可以发货');
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
});

function plainToDto(value: object): CreateOrderDto {
  return Object.assign(new CreateOrderDto(), value);
}
