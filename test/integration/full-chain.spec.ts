/**
 * 全链路集成测试：支付 → 入座 → 报单 → 奖励 → 钱包 → 提现 → 退款。
 *
 * 与单元测试的区别：跑在真实 MySQL 上（docker-compose.test.yml），
 * 验证真实 Schema 约束、唯一索引、行锁与事务隔离。
 * 微信网关仍用测试替身；沙箱路径代表"微信已成功"。
 *
 * 运行方式见同目录 README.md。
 */

import {
  balancesOf,
  addressOf,
  bootInt,
  buildIntHarness,
  credit,
  loginBuyer,
  mallProduct,
  resetDatabase,
  startupProduct,
  type IntHarness,
} from './support/int-harness';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../../src/modules/catalog/catalog.constants';

const stage: IntHarness = buildIntHarness(
  process.env.INTEGRATION_DATABASE_URL as string,
);

let rootId = 0n;

beforeEach(async () => {
  await resetDatabase(stage.prisma);
  rootId = await bootInt(stage);
});

afterAll(async () => {
  await stage.prisma.$disconnect();
});

describe('integration: full chain on real MySQL', () => {
  it('startup: pay → settle → seat → filing → awards, wechat callback is idempotent', async () => {
    const buyer = await loginBuyer(stage, 'it-startup', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 5);
    await credit(stage, buyer, 'points', 600);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.productId, quantity: 1 }],
    });
    expect(created.payAmountFen).toBe(1000);

    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order.pointsFen).toBe(600);
    expect(started.order.wechatFen).toBe(400);
    expect(started.wechat?.mode).toBe('sandbox');
    const payNo = started.wechat?.payNo;
    if (!payNo) {
      throw new Error('missing pay no');
    }

    await stage.wechatPay.simulateSuccess(payNo);
    await stage.wechatPay.simulateSuccess(payNo);

    const paid = await stage.orders.getForUser(buyer, created.id);
    expect(paid.status).toBe('paid');

    const balances = await balancesOf(stage, buyer);
    expect(balances.points.balanceFen).toBe(0n);

    const stock = await stage.prisma.skuStock.findUnique({ where: { skuId: product.skuId } });
    expect(Number(stock?.quantity ?? -1)).toBe(4);

    const buyerRow = await stage.prisma.user.findUnique({ where: { id: buyer } });
    expect(buyerRow).toMatchObject({ member: true, seated: true });
    const seat = await stage.prisma.marketTreeNode.findUnique({ where: { userId: buyer } });
    expect(seat?.parentUserId).toBe(rootId);

    // 报单（创业子单）
    const subOrders = await stage.prisma.startupSubOrder.findMany({ where: { userId: buyer } });
    expect(subOrders).toHaveLength(1);
    expect(Number(subOrders[0]?.amountFen)).toBe(1000);

    // 微信实收只记一笔（重复回调幂等，走真实唯一索引）
    const inflows = await stage.prisma.cashLedgerEntry.findMany({
      where: { bizType: 'order_wechat' },
    });
    expect(inflows).toHaveLength(1);
    expect(inflows[0]).toMatchObject({ direction: 'inflow', amountFen: 400n });

    // 上级奖励：销售奖 50（45/0/5）+ 见点奖 20（17/1/2）
    const rootBalances = await balancesOf(stage, rootId);
    expect(rootBalances.withdrawable.balanceFen).toBe(62n);
    expect(rootBalances.points.balanceFen).toBe(1n);
    expect(rootBalances.consumption.balanceFen).toBe(7n);
  });

  it('mall: mixed pay → ship → refund approved reclaims wallets and records wechat refund', async () => {
    const buyer = await loginBuyer(stage, 'it-mall', rootId);
    const addressId = await addressOf(stage, buyer);

    // 先成为会员
    const entry = await startupProduct(stage, '创业装', 2);
    await credit(stage, buyer, 'points', 1000);
    const entryOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: entry.productId, quantity: 1 }],
    });
    await stage.orders.pay(buyer, entryOrder.id);

    const goods = await mallProduct(stage, '礼盒', 300, 300, 5);
    await credit(stage, buyer, 'consumption', 100);
    await credit(stage, buyer, 'withdrawable', 50);
    const mall = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: goods.productId, quantity: 1 }],
    });
    expect(mall.payAmountFen).toBe(300);

    const started = await stage.orders.pay(buyer, mall.id);
    expect(started.order.consumptionFen).toBe(100);
    expect(started.order.withdrawableFen).toBe(50);
    expect(started.order.wechatFen).toBe(150);
    await stage.wechatPay.simulateSuccess(started.wechat!.payNo);

    const shipped = await stage.orders.ship(mall.id, {
      courierName: '顺丰',
      trackingNumber: 'SF100',
    });
    expect(shipped.status).toBe('shipped');

    const refund = await stage.refunds.apply(buyer, mall.id);
    expect(refund.status).toBe('pending');

    const approved = await stage.refunds.approve(refund.id, 1n, {});
    expect(approved).toMatchObject({
      status: 'approved',
      refundFen: 300,
      consumptionCreditFen: 100,
      withdrawableDeductionFen: 50,
      wechatRefundFen: 150,
      wechatRefundStatus: 'sandbox',
    });

    const balances = await balancesOf(stage, buyer);
    expect(balances.consumption.balanceFen).toBe(100n);
    expect(balances.withdrawable.balanceFen).toBe(0n);

    const refundOutflows = await stage.prisma.cashLedgerEntry.findMany({
      where: { bizType: 'wechat_refund' },
    });
    expect(refundOutflows).toHaveLength(1);
    expect(refundOutflows[0]).toMatchObject({ direction: 'outflow', amountFen: 150n });

    // 退款不回滚已发奖励：上级商城销售奖 15（14/1/0）仍在
    const rootBalances = await balancesOf(stage, rootId);
    expect(rootBalances.withdrawable.balanceFen).toBe(62n + 14n);
    expect(rootBalances.points.balanceFen).toBe(1n + 1n);
  });

  it('withdrawal: kyc + bank → apply freezes → payout debits with fee → reject releases', async () => {
    const payer = await loginBuyer(stage, 'it-payout', rootId);
    const addressId = await addressOf(stage, payer);
    const entry = await startupProduct(stage, '创业装', 2);
    await credit(stage, payer, 'points', 1000);
    const entryOrder = await stage.orders.create(payer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: entry.productId, quantity: 1 }],
    });
    await stage.orders.pay(payer, entryOrder.id);

    await stage.kyc.submit(payer, {
      realName: '张三',
      idNumber: '110101199003078881',
      mobile: '13800138000',
    });
    await stage.banks.save(payer, {
      accountName: '张三',
      bankName: '工商银行',
      accountNo: '6222021234567890',
      branchName: '杭州西湖支行',
    });
    await credit(stage, payer, 'withdrawable', 20000);

    const applied = await stage.withdrawals.apply(payer, 10000n);
    expect(applied.status).toBe('pending');
    const frozen = await balancesOf(stage, payer);
    expect(frozen.withdrawable).toMatchObject({ balanceFen: 10000n, frozenFen: 10000n });

    const paidView = await stage.withdrawals.payout(applied.id, 1n);
    expect(paidView).toMatchObject({ status: 'paid' });
    expect(paidView.settlement).toMatchObject({
      outcome: 'paid',
      amountFen: 10000n,
      feeFen: 100n,
      payoutFen: 9900n,
    });
    const afterPayout = await balancesOf(stage, payer);
    expect(afterPayout.withdrawable).toMatchObject({ balanceFen: 10000n, frozenFen: 0n });

    const payoutOutflows = await stage.prisma.cashLedgerEntry.findMany({
      where: { bizType: 'withdrawal_payout' },
    });
    expect(payoutOutflows).toHaveLength(1);
    expect(payoutOutflows[0]).toMatchObject({ direction: 'outflow', amountFen: 9900n });

    // 驳回路径解冻
    const other = await loginBuyer(stage, 'it-reject', rootId);
    await stage.kyc.submit(other, {
      realName: '李四',
      idNumber: '330106199001015679',
      mobile: '13800138001',
    });
    await stage.banks.save(other, {
      accountName: '李四',
      bankName: '建设银行',
      accountNo: '6222021234567891',
      branchName: '杭州西湖支行',
    });
    await credit(stage, other, 'withdrawable', 20000);
    const rejected = await stage.withdrawals.apply(other, 5000n);
    await stage.withdrawals.reject(rejected.id, 1n);
    const afterReject = await balancesOf(stage, other);
    expect(afterReject.withdrawable).toMatchObject({ balanceFen: 20000n, frozenFen: 0n });
  });

  it('compensation: cancelled order + late success → auto retry revives the order', async () => {
    const buyer = await loginBuyer(stage, 'it-comp', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '创业装', 5);
    await credit(stage, buyer, 'points', 600);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.productId, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    const payNo = started.wechat?.payNo;
    if (!payNo) {
      throw new Error('missing pay no');
    }
    await stage.orders.cancel(buyer, created.id);
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('closed');

    // 微信已扣款，本地订单已取消：登记补偿而不是直接拒绝
    await stage.wechatPay.simulateSuccess(payNo);
    const comps = await stage.prisma.settlementCompensation.findMany();
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({
      orderId: created.id,
      status: 'auto_retry',
      failReason: 'order_cancelled',
    });

    // 定时重试复活订单（真实 DB 上走完整结算事务）
    const attempted = await stage.compensations.runDue();
    expect(attempted).toBe(1);
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('paid');

    const after = await stage.prisma.settlementCompensation.findUnique({
      where: { orderId: created.id },
    });
    expect(after).toMatchObject({ status: 'completed' });
    const buyerRow = await stage.prisma.user.findUnique({ where: { id: buyer } });
    expect(buyerRow).toMatchObject({ member: true, seated: true });

    // 微信实收 + 补偿完成后的订单状态一致
    const inflows = await stage.prisma.cashLedgerEntry.findMany({
      where: { bizType: 'order_wechat' },
    });
    expect(inflows).toHaveLength(1);
  });
});
