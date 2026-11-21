import { buildStage1 } from './support/stage1-harness';

const PAID = 'paid';
const SHIPPED = 'shipped';
const CLOSED = 'closed';
const PENDING = 'pending_payment';

function orderData(input: {
  userId: bigint;
  zone: string;
  status: string;
  wechatFen: number;
  orderNo: string;
  orderId?: bigint;
}): Record<string, unknown> {
  return {
    orderNo: input.orderNo,
    userId: input.userId,
    zone: input.zone,
    status: input.status,
    goodsTotalFen: input.wechatFen,
    freightFen: 0,
    payAmountFen: input.wechatFen,
    pvFen: 0,
    pointsFen: 0,
    withdrawableFen: 0,
    consumptionFen: 0,
    wechatFen: input.wechatFen,
    contactName: '测试',
    contactPhone: '13800000000',
    province: '',
    city: '',
    district: '',
    detail: '',
    placedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function itemData(orderId: bigint, quantity: number): Record<string, unknown> {
  return {
    orderId,
    skuId: 1n,
    productName: '测试商品',
    skuName: '默认规格',
    unitPriceFen: 100000,
    pvFen: 0,
    freightFen: 0,
    quantity,
    lineTotalFen: 100000 * quantity,
    createdAt: new Date(),
  };
}

describe('admin users list and detail stats', () => {
  const now = new Date();
  const makeUser = (nickname: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'active',
    nickname,
    member: false,
    seated: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

  it('aggregates paid wechat amount, per-zone order counts, and invitee counts', async () => {
    const { db, adminUsers } = buildStage1();

    // 建三个用户：1 有创业+商城单并被 2 邀请过；2 无任何数据；3 有退款关闭与未支付单。
    db.user.create({ data: makeUser('甲', { member: true, seated: true }) });
    db.user.create({ data: makeUser('乙') });
    db.user.create({ data: makeUser('丙', { member: true, seated: true }) });

    // 用户 1：创业已支付 100 元 + 商城已发货 50 元。
    db.order.create({ data: orderData({ userId: 1n, zone: 'startup', status: PAID, wechatFen: 10000, orderNo: 'S1' }) });
    db.order.create({ data: orderData({ userId: 1n, zone: 'mall', status: SHIPPED, wechatFen: 5000, orderNo: 'M1' }) });
    // 用户 1：未支付单不应计入。
    db.order.create({ data: orderData({ userId: 1n, zone: 'startup', status: PENDING, wechatFen: 99999, orderNo: 'S2' }) });
    // 用户 3：退款关闭单不计入，商城已支付单计入。
    db.order.create({ data: orderData({ userId: 3n, zone: 'startup', status: CLOSED, wechatFen: 88888, orderNo: 'S3' }) });
    db.order.create({ data: orderData({ userId: 3n, zone: 'mall', status: PAID, wechatFen: 1200, orderNo: 'M3' }) });
    // 件数：S1 1 件、M1 2 件、M3 1 件；订单 id 按创建顺序为 1..5，关闭单(4)的件数不算。
    db.orderItem.create({ data: itemData(1n, 1) });
    db.orderItem.create({ data: itemData(2n, 2) });
    db.orderItem.create({ data: itemData(4n, 5) });
    db.orderItem.create({ data: itemData(5n, 1) });

    // 用户 2、3 都是被用户 1 直接邀请的。
    db.inviteTreeNode.create({ data: { userId: 2n, parentUserId: 1n, depth: 1, path: '1.2', joinedAt: new Date() } });
    db.inviteTreeNode.create({ data: { userId: 3n, parentUserId: 1n, depth: 1, path: '1.3', joinedAt: new Date() } });

    const page = await adminUsers.list({ page: 1, pageSize: 20 });
    expect(page.total).toBe(3);
    const byId = new Map(page.items.map((item) => [item.id.toString(), item]));

    expect(byId.get('1')).toMatchObject({
      paidWechatFen: 15000,
      startupPaidOrders: 1,
      mallPaidOrders: 1,
      startupPaidUnits: 1,
      mallPaidUnits: 2,
      inviteeCount: 2,
    });
    expect(byId.get('2')).toMatchObject({
      paidWechatFen: 0,
      startupPaidOrders: 0,
      mallPaidOrders: 0,
      startupPaidUnits: 0,
      mallPaidUnits: 0,
      inviteeCount: 0,
    });
    expect(byId.get('3')).toMatchObject({
      paidWechatFen: 1200,
      startupPaidOrders: 0,
      mallPaidOrders: 1,
      startupPaidUnits: 0,
      mallPaidUnits: 1,
      inviteeCount: 0,
    });

    // 详情接口同样带统计。
    const detail = await adminUsers.get(1n);
    expect(detail).toMatchObject({
      paidWechatFen: 15000,
      startupPaidOrders: 1,
      mallPaidOrders: 1,
      startupPaidUnits: 1,
      mallPaidUnits: 2,
      inviteeCount: 2,
    });
  });

  it('adds successful cofounder activation payments to the paid amount', async () => {
    const { db, adminUsers } = buildStage1();
    db.user.create({ data: makeUser('甲') });
    db.payment.create({
      data: {
        payNo: 'P1',
        channel: 'wechat',
        purpose: 'cofounder_activation',
        userId: 1n,
        amountFen: 99000,
        status: 'success',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    // 失败的开通支付不计入。
    db.payment.create({
      data: {
        payNo: 'P2',
        channel: 'wechat',
        purpose: 'cofounder_activation',
        userId: 1n,
        amountFen: 99000,
        status: 'failed',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const detail = await adminUsers.get(1n);
    expect(detail.paidWechatFen).toBe(99000);
    expect(detail.startupPaidOrders).toBe(0);
    expect(detail.mallPaidOrders).toBe(0);
    expect(detail.inviteeCount).toBe(0);
  });
});
