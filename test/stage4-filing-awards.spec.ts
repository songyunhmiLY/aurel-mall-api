import { BadRequestException } from '@nestjs/common';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import type { Prisma } from '@prisma/client';
import { attachInvite, graftMarket } from './support/stage2-harness';
import { buildStage4, stage4Locked, type Stage4 } from './support/stage4-harness';

const APRIL1_10 = new Date('2026-04-01T02:00:00.000Z');
const APRIL1_11 = new Date('2026-04-01T03:00:00.000Z');
const APRIL2_000030 = new Date('2026-04-01T16:00:30.000Z');
const APRIL2_0001 = new Date('2026-04-01T16:01:00.000Z');
const APRIL3_0001 = new Date('2026-04-02T16:01:00.000Z');
const APRIL5_10 = new Date('2026-04-05T02:00:00.000Z');

describe('stage 4 filing and awards', () => {
  async function boot(stage: Stage4): Promise<bigint> {
    await stage.users.onModuleInit();
    const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
    if (!root) {
      throw new Error('missing root');
    }
    return root.id;
  }

  async function credit(
    stage: Stage4,
    userId: bigint,
    walletType: 'points' | 'withdrawable' | 'consumption',
    amountFen: number,
  ): Promise<void> {
    await stage.wallet.credit({
      userId,
      walletType,
      amountFen: BigInt(amountFen),
      bizType: 'test_credit',
      bizId: `${walletType}-${userId.toString()}-${amountFen}-${stage.db.walletLedgerEntry.rows.length}`,
    });
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

  async function loginBuyer(
    stage: Stage4,
    subject: string,
    inviterUserId: bigint,
  ): Promise<bigint> {
    stage.wechat.logins.set(subject, { openid: `openid-${subject}`, unionid: null });
    const session = await stage.users.loginWithMiniProgram(subject);
    const inviter = stage.db.user.rows.find((row) => row.id === inviterUserId);
    const code = inviter?.inviteCode;
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('missing invite code');
    }
    await stage.users.bindInviter(session.user.id, code);
    return session.user.id;
  }

  async function startupProduct(stage: Stage4, name: string, stock: number, freightFen = 0) {
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name,
      freightFen,
      stockQuantity: stock,
      status: 'on',
    });
    return created.product;
  }

  function filingsOf(stage: Stage4, userId: bigint) {
    return stage.db.filing.rows
      .filter((row) => row.userId === userId)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  }

  it('files one sub-order immediately, keeps the daily backlog, and still pays the sales award', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    stage.clock.current = APRIL1_10;
    const buyer = await loginBuyer(stage, 'once', rootId);
    const product = await startupProduct(stage, '两件', 10);
    await credit(stage, buyer, 'points', 400_000);
    const addressId = await addressOf(stage, buyer);

    const first = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 2 }],
    });
    await stage.orders.pay(buyer, first.id);
    const firstSubs = stage.db.startupSubOrder.rows
      .filter((row) => row.orderId === first.id)
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    expect(firstSubs).toHaveLength(2);
    expect(filingsOf(stage, buyer)).toHaveLength(1);
    expect(filingsOf(stage, buyer)[0]?.subOrderId).toBe(firstSubs[0]?.id);
    expect(firstSubs[1]?.filedAt).toBeNull();

    const sales = stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === rootId && row.bizType === 'startup_sales',
    );
    expect(sales.map((row) => [row.walletType, row.amountFen])).toEqual(
      expect.arrayContaining([
        ['withdrawable', 8500n],
        ['points', 500n],
        ['consumption', 1000n],
      ]),
    );

    stage.clock.current = APRIL1_11;
    const second = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, second.id);
    expect(filingsOf(stage, buyer)).toHaveLength(1);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.userId === rootId && row.bizType === 'startup_sales',
      ),
    ).toHaveLength(6);

    stage.clock.current = APRIL2_000030;
    await stage.jobs.runDue();
    expect(filingsOf(stage, buyer)).toHaveLength(1);

    const third = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, third.id);
    expect(filingsOf(stage, buyer)).toHaveLength(2);
    expect(filingsOf(stage, buyer)[1]?.orderId).toBe(third.id);

    stage.clock.current = APRIL2_0001;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    expect(filingsOf(stage, buyer)).toHaveLength(2);
    expect(
      stage.db.startupSubOrder.rows.find((row) => row.id === firstSubs[1]?.id)?.filedAt,
    ).toBeNull();

    stage.clock.current = APRIL3_0001;
    await stage.jobs.runDue();
    expect(filingsOf(stage, buyer)).toHaveLength(3);
    expect(filingsOf(stage, buyer)[2]?.subOrderId).toBe(firstSubs[1]?.id);
    await stage.jobs.runDue();
    expect(filingsOf(stage, buyer)).toHaveLength(3);
  });

  it('includes freight in the startup sales base and still files one unit per N', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    stage.clock.current = APRIL1_10;
    const buyer = await loginBuyer(stage, 'freight', rootId);
    const product = await startupProduct(stage, '运费', 2, 100);
    await credit(stage, buyer, 'points', 100_000);
    const addressId = await addressOf(stage, buyer);
    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const paid = await stage.orders.pay(buyer, created.id);
    expect(paid.order.wechatFen).toBe(100);
    if (!paid.wechat) {
      throw new Error('missing wechat');
    }
    await stage.wechatPay.simulateSuccess(paid.wechat.payNo);
    expect(stage.db.startupSubOrder.rows.filter((row) => row.orderId === created.id)).toHaveLength(
      1,
    );
    const sales = stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === rootId && row.bizType === 'startup_sales',
    );
    expect(sales.map((row) => [row.walletType, row.amountFen])).toEqual(
      expect.arrayContaining([
        ['withdrawable', 4255n],
        ['points', 250n],
        ['consumption', 500n],
      ]),
    );
  });

  it('breaks same-time backlog ties by the smaller sub-order id and catches up missed days', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    stage.clock.current = APRIL1_10;
    const buyer = await loginBuyer(stage, 'tie', rootId);
    const product = await startupProduct(stage, '并列', 10);
    await credit(stage, buyer, 'points', 500_000);
    const addressId = await addressOf(stage, buyer);
    const placed: bigint[] = [];
    for (let index = 0; index < 3; index += 1) {
      const order = await stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId,
        items: [{ productId: product.id, quantity: 1 }],
      });
      await stage.orders.pay(buyer, order.id);
      placed.push(order.id);
    }
    expect(filingsOf(stage, buyer)).toHaveLength(1);
    expect(filingsOf(stage, buyer)[0]?.orderId).toBe(placed[0]);
    const pending = stage.db.startupSubOrder.rows
      .filter((row) => row.filedAt === null)
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    expect(pending.map((row) => row.orderId)).toEqual([placed[1], placed[2]]);

    stage.clock.current = APRIL2_0001;
    await stage.jobs.runDue();
    expect(filingsOf(stage, buyer)[1]?.orderId).toBe(placed[1]);

    stage.clock.current = APRIL5_10;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    expect(filingsOf(stage, buyer)).toHaveLength(3);
    expect(filingsOf(stage, buyer)[2]?.orderId).toBe(placed[2]);
  });

  it('pays filing k when sequence 5k completes and does not pay the other filings', async () => {
    const locked = Object.freeze({
      ...stage4Locked(),
      startupSalesRatioBps: 0,
      startupPointRatioBps: 0,
    });
    const stage = buildStage4(locked);
    const rootId = await boot(stage);
    stage.clock.current = APRIL1_10;
    const product = await startupProduct(stage, '公排', 20);
    const buyers: bigint[] = [];
    for (let index = 0; index < 10; index += 1) {
      const buyer = await loginBuyer(stage, `queue-${index}`, rootId);
      await credit(stage, buyer, 'points', 100_000);
      const addressId = await addressOf(stage, buyer);
      const order = await stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId,
        items: [{ productId: product.id, quantity: 1 }],
      });
      await stage.orders.pay(buyer, order.id);
      buyers.push(buyer);
    }
    const ordered = [...stage.db.filing.rows].sort(
      (left, right) => Number(left.sequence) - Number(right.sequence),
    );
    expect(ordered.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ordered.map((row) => row.userId)).toEqual(buyers);
    expect(stage.db.filingSettlement.rows).toHaveLength(2);
    expect(
      stage.db.filingSettlement.rows
        .map((row) => Number(row.triggerSequence))
        .sort((a, b) => a - b),
    ).toEqual([5, 10]);
    expect(
      stage.db.filingSettlement.rows.find((row) => row.triggerSequence === 5)?.beneficiaryUserId,
    ).toBe(buyers[0]);
    expect(
      stage.db.filingSettlement.rows.find((row) => row.triggerSequence === 10)?.beneficiaryUserId,
    ).toBe(buyers[1]);

    const first = await stage.wallet.getBalances(buyers[0]!);
    const second = await stage.wallet.getBalances(buyers[1]!);
    const third = await stage.wallet.getBalances(buyers[2]!);
    expect(first.points.balanceFen).toBe(100_000n);
    expect(first.withdrawable.balanceFen).toBe(20_000n);
    expect(second.points.balanceFen).toBe(100_000n);
    expect(second.withdrawable.balanceFen).toBe(20_000n);
    expect(third.points.balanceFen).toBe(0n);
    expect(third.withdrawable.balanceFen).toBe(0n);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.bizType === 'filing_settlement' && row.userId === buyers[2],
      ),
    ).toHaveLength(0);

    const listed = await stage.filingQuery.list({ sequence: 5, page: 1, pageSize: 20 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.triggeredSettlement?.beneficiaryUserId).toBe(buyers[0]);
    expect(listed.items[0]?.bizDate).toBe('2026-04-01');
    const received = await stage.filingQuery.listSettlements({
      userId: buyers[0],
      page: 1,
      pageSize: 20,
    });
    expect(received.items).toHaveLength(1);
    expect(received.items[0]?.pointsFen).toBe(100_000n);
    expect(received.items[0]?.withdrawableFen).toBe(20_000n);

    const before = stage.db.walletLedgerEntry.rows.length;
    const order = stage.db.order.rows[0];
    if (!order) {
      throw new Error('missing order');
    }
    await stage.paid.afterOrderPaid({
      tx: stage.db as unknown as Prisma.TransactionClient,
      orderId: order.id as bigint,
      userId: order.userId as bigint,
      zone: 'startup',
      payAmountFen: Number(order.payAmountFen),
      pvFen: 0,
      paidAt: stage.clock.current,
    });
    expect(stage.db.walletLedgerEntry.rows).toHaveLength(before);
    expect(stage.db.filing.rows).toHaveLength(10);
  });

  it('pays startup layers with the startup split and skips a layer that fails', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    const sales = await loginBuyer(stage, 'sales', rootId);
    stage.db.user.update({
      where: { id: sales },
      data: { member: true, seated: true, inviteCode: '111111' },
    });
    const ancestors: bigint[] = [];
    let parent = rootId;
    for (let layer = 13; layer >= 1; layer -= 1) {
      const id = insertUser(stage, `层${layer}`);
      graftMarket(stage.db, id, parent, stage.clock.current);
      ancestors[layer - 1] = id;
      parent = id;
    }
    const buyer = await loginBuyer(stage, 'deep', sales);
    const marketParent = ancestors[0];
    if (!marketParent) {
      throw new Error('missing market parent');
    }
    graftMarket(stage.db, buyer, marketParent, stage.clock.current);
    grantGate(stage, ancestors[4], 3, 0);
    grantGate(stage, ancestors[5], 3, 3);
    grantGate(stage, ancestors[6], 0, 5);
    grantGate(stage, ancestors[7], 3, 3);
    grantGate(stage, ancestors[8], 5, 0);
    grantGate(stage, ancestors[9], 5, 5);
    grantGate(stage, ancestors[10], 0, 5);
    grantGate(stage, ancestors[11], 5, 5);

    const product = await startupProduct(stage, '见点', 5);
    await credit(stage, buyer, 'points', 100_000);
    const addressId = await addressOf(stage, buyer);
    const order = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, order.id);

    const pointUsers = new Set(
      stage.db.rewardLedgerEntry.rows
        .filter((row) => row.rewardType === 'startup_points')
        .map((row) => row.userId?.toString()),
    );
    expect(pointUsers.has(ancestors[0]?.toString())).toBe(true);
    expect(pointUsers.has(ancestors[3]?.toString())).toBe(true);
    expect(pointUsers.has(ancestors[4]?.toString())).toBe(false);
    expect(pointUsers.has(ancestors[5]?.toString())).toBe(true);
    expect(pointUsers.has(ancestors[6]?.toString())).toBe(false);
    expect(pointUsers.has(ancestors[7]?.toString())).toBe(true);
    expect(pointUsers.has(ancestors[8]?.toString())).toBe(false);
    expect(pointUsers.has(ancestors[9]?.toString())).toBe(true);
    expect(pointUsers.has(ancestors[10]?.toString())).toBe(false);
    expect(pointUsers.has(ancestors[11]?.toString())).toBe(true);
    expect(pointUsers.has(ancestors[12]?.toString())).toBe(false);
    expect(pointUsers.has(buyer.toString())).toBe(false);
    expect(pointUsers.has(sales.toString())).toBe(false);

    const salesAward = await stage.wallet.getBalances(sales);
    expect(salesAward.withdrawable.balanceFen).toBe(4250n);
    expect(salesAward.points.balanceFen).toBe(250n);
    expect(salesAward.consumption.balanceFen).toBe(500n);
    const layerSix = ancestors[5];
    if (!layerSix) {
      throw new Error('missing layer');
    }
    const seen = await stage.wallet.getBalances(layerSix);
    expect(seen.withdrawable.balanceFen).toBe(1700n);
    expect(seen.points.balanceFen).toBe(100n);
    expect(seen.consumption.balanceFen).toBe(200n);

    const layerQuery = await stage.awardAdmin.list({
      orderId: order.id,
      rewardType: 'startup_points',
      layer: 6,
      page: 1,
      pageSize: 20,
    });
    expect(layerQuery.items.map((item) => item.userId)).toEqual([layerSix]);
    expect(layerQuery.items[0]?.wallets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ walletType: 'withdrawable', amountFen: 1700n }),
        expect.objectContaining({ walletType: 'points', amountFen: 100n }),
        expect.objectContaining({ walletType: 'consumption', amountFen: 200n }),
      ]),
    );

    const invite = await stage.network.invite(buyer);
    expect(invite.inviter?.userId).toBe(sales);
    const up = await stage.network.ancestors(buyer);
    expect(up.items.map((item) => item.userId)).toEqual([sales, rootId]);
    const down = await stage.network.descendants(rootId, 1);
    expect(down.items.map((item) => item.userId)).toContain(sales);
    expect(down.items.map((item) => item.userId)).not.toContain(buyer);
    const tree = await stage.network.marketTree(ancestors[1]!);
    expect(tree.seated).toBe(true);
    expect(tree.parent?.userId).toBe(ancestors[2]);
    expect(tree.markets.map((market) => market.nickname)).toEqual(['层1']);
    expect(tree.markets[0]?.members.map((member) => member.userId)).toEqual(
      expect.arrayContaining([ancestors[0], buyer]),
    );

    const team = await stage.team.getForUser(ancestors[1]!);
    expect(Object.keys(team).join(' ')).not.toContain('节点');
    expect(team.markets[0] && Object.keys(team.markets[0]).join(' ')).not.toMatch(/节点|市场树/);
    expect(team.marketCount).toBe(1);
    expect(team.totalPerformanceFen).toBe(100_000n);
    expect(team.markets[0]).toMatchObject({
      name: '层1',
      monthPerformanceFen: 100_000n,
      todayPerformanceFen: 100_000n,
      recent7DaysPerformanceFen: 100_000n,
    });
    const empty = await stage.team.getForUser(buyer);
    expect(empty).toMatchObject({ marketCount: 0, totalPerformanceFen: 0n, markets: [] });
  });

  it('pays mall awards on the invite tree only, with the mall split, and stops at layer 15', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    let parent = rootId;
    const links: bigint[] = [];
    for (let layer = 16; layer >= 1; layer -= 1) {
      const id = insertUser(stage, `邀${layer}`);
      stage.db.user.update({
        where: { id },
        data: { inviteCode: String(200_000 + layer) },
      });
      attachInvite(stage.db, id, parent, stage.clock.current);
      parent = id;
      links[layer - 1] = id;
    }
    const inviter = links[0];
    if (!inviter) {
      throw new Error('missing inviter');
    }
    const buyer = await loginBuyer(stage, 'mall-buyer', inviter);
    const outsider = insertUser(stage, '旁路');
    graftMarket(stage.db, outsider, rootId, stage.clock.current);
    graftMarket(stage.db, buyer, outsider, stage.clock.current);
    stage.db.user.update({
      where: { id: buyer },
      data: { member: true, seated: true },
    });
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '商城',
      freightFen: 0,
      priceFen: 10_000,
      pvFen: 10_000,
      stockQuantity: 5,
      status: 'on',
    });
    await credit(stage, buyer, 'consumption', 10_000);
    const addressId = await addressOf(stage, buyer);
    const order = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: created.product.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, order.id);

    const direct = await stage.wallet.getBalances(inviter);
    expect(direct.withdrawable.balanceFen).toBe(425n);
    expect(direct.points.balanceFen).toBe(50n);
    expect(direct.consumption.balanceFen).toBe(25n);
    expect(
      stage.db.rewardLedgerEntry.rows.filter(
        (row) => row.userId === inviter && row.rewardType === 'mall_points',
      ),
    ).toHaveLength(0);
    const second = links[1];
    if (!second) {
      throw new Error('missing layer 2');
    }
    const point = await stage.wallet.getBalances(second);
    expect(point.withdrawable.balanceFen).toBe(170n);
    expect(point.points.balanceFen).toBe(20n);
    expect(point.consumption.balanceFen).toBe(10n);
    const lastPaid = links[14];
    const beyond = links[15];
    expect(
      stage.db.rewardLedgerEntry.rows.some((row) => row.userId === lastPaid && row.layer === 15),
    ).toBe(true);
    expect(stage.db.rewardLedgerEntry.rows.some((row) => row.userId === beyond)).toBe(false);
    expect(stage.db.rewardLedgerEntry.rows.some((row) => row.userId === outsider)).toBe(false);
    expect(stage.db.filing.rows.filter((row) => row.userId === buyer)).toHaveLength(0);

    const salesOnly = await stage.awardAdmin.list({
      orderId: order.id,
      rewardType: 'mall_sales',
      layer: 1,
      page: 1,
      pageSize: 20,
    });
    expect(salesOnly.items.map((item) => item.userId)).toEqual([inviter]);
    await expect(
      stage.awardAdmin.list({ rewardType: 'filing_settlement', page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(stage.network.marketTree(outsider)).resolves.toMatchObject({
      seated: true,
      markets: [expect.objectContaining({ userId: buyer })],
    });
  });
});

function insertUser(stage: Stage4, nickname: string): bigint {
  const now = stage.clock.current;
  const row = stage.db.user.create({
    data: {
      status: 'active',
      nickname,
      avatarUrl: null,
      phone: null,
      inviteCode: null,
      member: true,
      seated: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  return row.id;
}

function grantGate(
  stage: Stage4,
  userId: bigint | undefined,
  subOrders: number,
  invitees: number,
): void {
  if (userId === undefined) {
    throw new Error('missing user');
  }
  const now = stage.clock.current;
  for (let index = 0; index < subOrders; index += 1) {
    stage.db.startupSubOrder.create({
      data: {
        userId,
        orderId: 9_000n + userId,
        orderAt: now,
        paidAt: now,
        amountFen: 100_000,
        filedAt: null,
        createdAt: now,
      },
    });
  }
  for (let index = 0; index < invitees; index += 1) {
    const child = insertUser(stage, `${userId.toString()}-邀${index}`);
    attachInvite(stage.db, child, userId, now);
  }
}
