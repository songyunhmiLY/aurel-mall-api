import { PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { buildStage4, type Stage4 } from './support/stage4-harness';

describe('user messages', () => {
  async function boot(stage: Stage4): Promise<bigint> {
    await stage.users.onModuleInit();
    const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
    if (!root) {
      throw new Error('missing root');
    }
    return root.id;
  }

  async function loginBuyer(stage: Stage4, subject: string, inviterUserId: bigint) {
    stage.wechat.logins.set(subject, { openid: `openid-${subject}`, unionid: null });
    const session = await stage.users.loginWithMiniProgram(subject);
    const inviter = stage.db.user.rows.find((row) => row.id === inviterUserId);
    const code = inviter?.inviteCode;
    if (typeof code === 'string' && code.length > 0) {
      await stage.users.bindInviter(session.user.id, code);
    }
    return session.user.id;
  }

  async function addressOf(stage: Stage4, userId: bigint): Promise<bigint> {
    const address = await stage.addresses.create(userId, {
      contactName: '张三',
      contactPhone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文三路 1 号',
      isDefault: true,
    });
    return address.id;
  }

  async function credit(stage: Stage4, userId: bigint, walletType: 'points', amountFen: number) {
    await stage.wallet.credit({
      userId,
      walletType,
      amountFen: BigInt(amountFen),
      bizType: 'test_credit',
      bizId: `${walletType}-${userId.toString()}-${amountFen}-${stage.db.walletLedgerEntry.rows.length}`,
    });
  }

  it('records order messages and clears the red dot after the list is opened', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'msg-buyer', rootId);
    const addressId = await addressOf(stage, buyer);
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '消息商品',
      freightFen: 0,
      stockQuantity: 5,
      status: 'on',
    });

    await credit(stage, buyer, 'points', 200_000);
    const order = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: created.product.id, quantity: 2 }],
    });
    const paid = await stage.orders.pay(buyer, order.id);
    expect(paid.order.wechatFen).toBe(0);
    expect(paid.order.status).toBe('paid');

    const first = await stage.messages.listForUser(buyer, { page: 1, pageSize: 20 });
    expect(first.total).toBe(1);
    expect(first.items[0]?.title).toBe('支付成功');
    expect(first.items[0]?.category).toBe('order');
    expect(first.items[0]?.read).toBe(false);
    expect(first.items[0]?.linkPage).toContain('/pages/order/detail');
    expect(first.unreadCount).toBe(1);

    // 打开列表即全部已读：只推时间，不改消息行
    await stage.messages.markRead(buyer);
    const second = await stage.messages.listForUser(buyer, { page: 1, pageSize: 20 });
    expect(second.unreadCount).toBe(0);
    expect(second.items[0]?.read).toBe(true);

    // 已读之后的新消息重新点亮红点
    stage.clock.current = new Date(stage.clock.current.getTime() + 60_000);
    await stage.orders.ship(order.id, { courierName: '顺丰', trackingNumber: 'SF123456' });
    const third = await stage.messages.listForUser(buyer, { page: 1, pageSize: 20 });
    expect(third.total).toBe(2);
    expect(third.items[0]?.title).toBe('订单已发货');
    expect(third.items[0]?.body).toContain('SF123456');
    expect(third.unreadCount).toBe(1);
    await expect(stage.messages.unreadCount(buyer)).resolves.toEqual({ unreadCount: 1 });

    // 分类筛选：没有资金类消息时返回空列表
    const walletOnly = await stage.messages.listForUser(buyer, {
      category: 'wallet',
      page: 1,
      pageSize: 20,
    });
    expect(walletOnly.total).toBe(0);
    expect(walletOnly.items).toHaveLength(0);
  });
});
