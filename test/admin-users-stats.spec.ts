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

    // 用户 1：创业已支付 100 元（应付 120 元，积分抵 20）+ 商城已发货 50 元（2 件）。
    const startupOrder = db.order.create({
      data: orderData({ userId: 1n, zone: 'startup', status: PAID, wechatFen: 10000, orderNo: 'S1' }),
    });
    db.order.update({
      where: { id: startupOrder.id },
      data: { payAmountFen: 12000, pointsFen: 2000 },
    });
    db.order.create({ data: orderData({ userId: 1n, zone: 'mall', status: SHIPPED, wechatFen: 5000, orderNo: 'M1' }) });
    // 用户 1：未支付单不应计入。
    db.order.create({ data: orderData({ userId: 1n, zone: 'startup', status: PENDING, wechatFen: 99999, orderNo: 'S2' }) });
    // 用户 3：退款关闭单不计入，商城已支付单计入。
    db.order.create({ data: orderData({ userId: 3n, zone: 'startup', status: CLOSED, wechatFen: 88888, orderNo: 'S3' }) });
    const mallOrder3 = db.order.create({
      data: orderData({ userId: 3n, zone: 'mall', status: PAID, wechatFen: 1200, orderNo: 'M3' }),
    });
    db.order.update({
      where: { id: mallOrder3.id },
      data: { payAmountFen: 2000, consumptionFen: 800 },
    });
    // 件数：S1 1 件、M1 2 件、M3 1 件；订单 id 按创建顺序为 1..5，关闭单(4)的件数不算。
    db.orderItem.create({ data: itemData(1n, 1) });
    db.orderItem.create({ data: itemData(2n, 2) });
    db.orderItem.create({ data: itemData(4n, 5) });
    db.orderItem.create({ data: itemData(5n, 1) });

    // 用户 2、3 都是被用户 1 直接邀请的。
    db.inviteTreeNode.create({ data: { userId: 2n, parentUserId: 1n, depth: 1, path: '1.2', joinedAt: new Date() } });
    db.inviteTreeNode.create({ data: { userId: 3n, parentUserId: 1n, depth: 1, path: '1.3', joinedAt: new Date() } });

    // 用户 1 的钱包余额：可提现 300、积分 40、消费金 20；累计提现 100。
    db.walletAccount.create({ data: { userId: 1n, walletType: 'withdrawable', balanceFen: 30000n, frozenFen: 0n, updatedAt: now } });
    db.walletAccount.create({ data: { userId: 1n, walletType: 'points', balanceFen: 4000n, frozenFen: 0n, updatedAt: now } });
    db.walletAccount.create({ data: { userId: 1n, walletType: 'consumption', balanceFen: 2000n, frozenFen: 0n, updatedAt: now } });
    db.withdrawalSettlement.create({
      data: { applicationId: 1n, userId: 1n, outcome: 'paid', amountFen: 10000n, adminId: 1n, settledAt: now },
    });
    // 驳回的提现不计入。
    db.withdrawalSettlement.create({
      data: { applicationId: 2n, userId: 1n, outcome: 'rejected', amountFen: 50000n, adminId: 1n, settledAt: now },
    });
    // 用户 1 同时是在籍联创与工作室；用户 3 是在籍运营团队。
    db.cofounderEnrollment.create({ data: { userId: 1n, status: 'active', source: 'appointment', enrolledAt: now, createdAt: now, updatedAt: now } });
    db.studioEnrollment.create({ data: { userId: 1n, status: 'active', appointedByAdminId: 1n, enrolledAt: now, createdAt: now, updatedAt: now } });
    // 取消的联创不算。
    db.cofounderEnrollment.create({ data: { userId: 2n, status: 'cancelled', source: 'appointment', enrolledAt: now, cancelledAt: now, createdAt: now, updatedAt: now } });
    db.opsTeamEnrollment.create({ data: { userId: 3n, status: 'active', appointedByAdminId: 1n, enrolledAt: now, activeSlot: 1, createdAt: now, updatedAt: now } });

    const page = await adminUsers.list({ page: 1, pageSize: 20 });
    expect(page.total).toBe(3);
    const byId = new Map(page.items.map((item) => [item.id.toString(), item]));

    expect(byId.get('1')).toMatchObject({
      startupPaidFen: 10000,
      startupPayableFen: 12000,
      mallPaidFen: 5000,
      mallPayableFen: 5000,
      startupPaidOrders: 1,
      mallPaidOrders: 1,
      startupPaidUnits: 1,
      mallPaidUnits: 2,
      withdrawableBalanceFen: 30000,
      pointsBalanceFen: 4000,
      consumptionBalanceFen: 2000,
      totalWithdrawnFen: 10000,
      inviteeCount: 2,
      identities: ['member', 'cofounder', 'studio'],
    });
    expect(byId.get('2')).toMatchObject({
      startupPaidFen: 0,
      mallPaidFen: 0,
      totalWithdrawnFen: 0,
      inviteeCount: 0,
      identities: ['normal'],
    });
    expect(byId.get('3')).toMatchObject({
      mallPaidFen: 1200,
      mallPayableFen: 2000,
      mallPaidOrders: 1,
      mallPaidUnits: 1,
      totalWithdrawnFen: 0,
      inviteeCount: 0,
      identities: ['member', 'ops_team'],
    });

    // 详情接口同样带统计。
    const detail = await adminUsers.get(1n);
    expect(detail).toMatchObject({
      startupPaidFen: 10000,
      startupPayableFen: 12000,
      mallPaidFen: 5000,
      startupPaidUnits: 1,
      mallPaidUnits: 2,
      totalWithdrawnFen: 10000,
      identities: ['member', 'cofounder', 'studio'],
      inviteeCount: 2,
    });
  });

  it('does not count cofounder activation payments as order paid amount', async () => {
    const { db, adminUsers } = buildStage1();
    db.user.create({ data: makeUser('甲', { seated: true, member: true }) });
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
    const detail = await adminUsers.get(1n);
    // 累计实付只算创业+商城订单，开通支付不混入。
    expect(detail.startupPaidFen).toBe(0);
    expect(detail.mallPaidFen).toBe(0);
    expect(detail.identities).toEqual(['member']);
    expect(detail.inviteeCount).toBe(0);
  });
});
