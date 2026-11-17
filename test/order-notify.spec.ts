import { runNotifyTransaction } from '../src/common/notify/notify-buffer';
import type { NotifyIntent } from '../src/common/notify/notify-intent';
import { PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { buildStage4, type Stage4 } from './support/stage4-harness';

/**
 * 订单支付成功与发货各入队一条订阅消息意向。
 * 站内消息已有用例，这里只看订阅消息的入队和空位取值。
 */
describe('order subscription intents', () => {
  async function boot(stage: Stage4): Promise<bigint> {
    await stage.users.onModuleInit();
    const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
    if (!root) {
      throw new Error('missing root');
    }
    return root.id;
  }

  async function collect(work: () => Promise<unknown>): Promise<NotifyIntent[]> {
    const intents: NotifyIntent[] = [];
    await runNotifyTransaction(work, async (items) => {
      intents.push(...items);
    });
    return intents;
  }

  it('queues one paid intent and one shipped intent with the order data', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    stage.wechat.logins.set('notify-buyer', { openid: 'openid-notify-buyer', unionid: null });
    const session = await stage.users.loginWithMiniProgram('notify-buyer');
    const buyer = session.user.id;
    const inviter = stage.db.user.rows.find((row) => row.id === rootId);
    if (typeof inviter?.inviteCode === 'string') {
      await stage.users.bindInviter(buyer, inviter.inviteCode);
    }
    const address = await stage.addresses.create(buyer, {
      contactName: '张三',
      contactPhone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文三路 1 号',
      isDefault: true,
    });
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '订阅消息商品',
      freightFen: 0,
      stockQuantity: 5,
      status: 'on',
    });
    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 200_000n,
      bizType: 'test_credit',
      bizId: `points-${buyer.toString()}-1`,
    });
    const order = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId: address.id,
      items: [{ productId: created.product.id, quantity: 2 }],
    });

    const paidIntents = await collect(() => stage.orders.pay(buyer, order.id));
    const paid = paidIntents.filter((intent) => intent.type === 'order_paid');
    expect(paid).toHaveLength(1);
    const paidIntent = paid[0];
    expect(paidIntent?.type).toBe('order_paid');
    if (paidIntent?.type === 'order_paid') {
      expect(paidIntent.orderNo).toBe(order.orderNo);
      expect(paidIntent.amountFen).toBe(BigInt(order.payAmountFen));
      expect(paidIntent.goodsName).toBe('订阅消息商品 等 2 件');
    }

    const shippedIntents = await collect(() =>
      stage.orders.ship(order.id, { courierName: '顺丰', trackingNumber: 'SF123456' }),
    );
    const shipped = shippedIntents.filter((intent) => intent.type === 'order_shipped');
    expect(shipped).toHaveLength(1);
    const shippedIntent = shipped[0];
    if (shippedIntent?.type === 'order_shipped') {
      expect(shippedIntent.orderNo).toBe(order.orderNo);
      expect(shippedIntent.courierName).toBe('顺丰');
      expect(shippedIntent.trackingNo).toBe('SF123456');
      expect(shippedIntent.userId).toBe(buyer);
    }
  });

  it('truncates a long goods name so the wechat slot still fits', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    stage.wechat.logins.set('notify-long', { openid: 'openid-notify-long', unionid: null });
    const session = await stage.users.loginWithMiniProgram('notify-long');
    const buyer = session.user.id;
    const inviter = stage.db.user.rows.find((row) => row.id === rootId);
    if (typeof inviter?.inviteCode === 'string') {
      await stage.users.bindInviter(buyer, inviter.inviteCode);
    }
    const address = await stage.addresses.create(buyer, {
      contactName: '李四',
      contactPhone: '13900139000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文三路 2 号',
      isDefault: true,
    });
    const longName = '奥瑞尔创业专区超长名称礼包第一版限定发行装';
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: longName,
      freightFen: 0,
      stockQuantity: 5,
      status: 'on',
    });
    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 200_000n,
      bizType: 'test_credit',
      bizId: `points-${buyer.toString()}-1`,
    });
    const order = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId: address.id,
      items: [{ productId: created.product.id, quantity: 1 }],
    });
    const intents = await collect(() => stage.orders.pay(buyer, order.id));
    const paid = intents.find((intent) => intent.type === 'order_paid');
    if (paid?.type === 'order_paid') {
      expect(paid.goodsName.length).toBeLessThanOrEqual(20);
      expect(paid.goodsName.endsWith('…')).toBe(true);
    } else {
      throw new Error('missing order paid intent');
    }
  });
});
