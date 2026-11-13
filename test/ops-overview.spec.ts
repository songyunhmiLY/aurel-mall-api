import { toJsonSafe } from '../src/common/http/api-response';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { nextLuckyReturn } from '../src/modules/ops/ops-filing-display';
import { OpsOverviewService } from '../src/modules/ops/ops-overview.service';
import { previousShanghaiDay, resolveOpsPeriod } from '../src/modules/ops/ops-period';
import {
  CASH_OUTFLOW,
  CASH_WECHAT_REFUND,
  CASH_WITHDRAWAL_PAYOUT,
} from '../src/modules/wallet/wallet.constants';
import { buildStage4 } from './support/stage4-harness';

const NOW = new Date('2026-11-13T08:00:00.000Z');
const TODAY_START = new Date('2026-11-12T16:00:00.000Z');
const TODAY_END = new Date('2026-11-13T16:00:00.000Z');
const YESTERDAY_AT = new Date('2026-11-12T10:00:00.000Z');
const TODAY_AT = new Date('2026-11-13T01:00:00.000Z');
const MONTH_END = new Date('2026-11-30T16:00:00.000Z');
const BEFORE_MONTH = new Date('2026-10-31T15:00:00.000Z');

describe('ops overview period bounds', () => {
  it('uses Shanghai natural days, including the midnight that is still the previous UTC date', () => {
    const today = resolveOpsPeriod(NOW, {});
    expect(today.key).toBe('today');
    expect(today.from.toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(today.until.toISOString()).toBe('2026-11-13T16:00:00.000Z');

    const named = resolveOpsPeriod(NOW, { period: 'today' });
    expect(named.from.toISOString()).toBe(today.from.toISOString());

    const yesterday = resolveOpsPeriod(NOW, { period: 'yesterday' });
    expect(yesterday.from.toISOString()).toBe('2026-11-11T16:00:00.000Z');
    expect(yesterday.until.toISOString()).toBe('2026-11-12T16:00:00.000Z');

    const week = resolveOpsPeriod(NOW, { period: 'last7days' });
    expect(week.from.toISOString()).toBe('2026-11-06T16:00:00.000Z');
    expect(week.until.toISOString()).toBe('2026-11-13T16:00:00.000Z');

    const month = resolveOpsPeriod(NOW, { period: 'month' });
    expect(month.from.toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(month.until.toISOString()).toBe('2026-11-30T16:00:00.000Z');
  });

  it('accepts inclusive Shanghai dates and exclusive instants, and rejects a bad range', () => {
    const dates = resolveOpsPeriod(NOW, {
      period: 'custom',
      from: '2026-11-12',
      to: '2026-11-12',
    });
    expect(dates.from.toISOString()).toBe('2026-11-11T16:00:00.000Z');
    expect(dates.until.toISOString()).toBe('2026-11-12T16:00:00.000Z');

    const instants = resolveOpsPeriod(NOW, {
      period: 'custom',
      from: '2026-11-13T02:00:00+08:00',
      to: '2026-11-13T03:00:00+08:00',
    });
    expect(instants.from.toISOString()).toBe('2026-11-12T18:00:00.000Z');
    expect(instants.until.toISOString()).toBe('2026-11-12T19:00:00.000Z');

    const previous = previousShanghaiDay(instants.from);
    expect(previous.bizDate).toBe('2026-11-12');
    expect(previous.until.toISOString()).toBe('2026-11-12T16:00:00.000Z');

    expect(() => resolveOpsPeriod(NOW, { period: 'week' })).toThrow('周期不正确');
    expect(() => resolveOpsPeriod(NOW, { period: 'today', from: '2026-11-13' })).toThrow(
      '该周期不接受 from 或 to',
    );
    expect(() => resolveOpsPeriod(NOW, { period: 'custom', from: '2026-11-13' })).toThrow(
      '自定义区间需要 from 和 to',
    );
    expect(() =>
      resolveOpsPeriod(NOW, { period: 'custom', from: '2026-11-13', to: '2026-11-12' }),
    ).toThrow('结束必须晚于开始');
    expect(() =>
      resolveOpsPeriod(NOW, { period: 'custom', from: '2026-02-31', to: '2026-03-01' }),
    ).toThrow('开始和结束不正确');
    expect(() =>
      resolveOpsPeriod(NOW, {
        period: 'custom',
        from: '2026-11-13T00:00:00',
        to: '2026-11-14T00:00:00Z',
      }),
    ).toThrow('开始和结束不正确');

    const start = new Date('2026-01-01T00:00:00.000Z');
    const limit = new Date(start.getTime() + 370 * 24 * 60 * 60 * 1000);
    expect(
      resolveOpsPeriod(NOW, {
        period: 'custom',
        from: start.toISOString(),
        to: limit.toISOString(),
      }).until.toISOString(),
    ).toBe(limit.toISOString());
    expect(() =>
      resolveOpsPeriod(NOW, {
        period: 'custom',
        from: start.toISOString(),
        to: new Date(limit.getTime() + 1).toISOString(),
      }),
    ).toThrow('自定义区间不能超过 370 个自然日');
  });
});

describe('lucky-return display sequence', () => {
  it('pays filing k when the public sequence reaches 5k', () => {
    expect(nextLuckyReturn(0)).toEqual({ triggerSequence: 5, beneficiarySequence: 1 });
    expect(nextLuckyReturn(4)).toEqual({ triggerSequence: 5, beneficiarySequence: 1 });
    expect(nextLuckyReturn(5)).toEqual({ triggerSequence: 10, beneficiarySequence: 2 });
    expect(nextLuckyReturn(6)).toEqual({ triggerSequence: 10, beneficiarySequence: 2 });
  });
});

describe('ops overview metrics', () => {
  const stage = buildStage4();
  stage.clock.current = NOW;
  const ops = new OpsOverviewService(
    stage.db as unknown as PrismaService,
    stage.clock as unknown as ClockService,
    stage.positions,
    stage.locked,
  );

  beforeAll(async () => {
    await seed(stage.db);
  });

  it('keeps WeChat cash, payable, and wallet liabilities apart', async () => {
    const overview = await ops.get({ period: 'today' });
    expect(overview.period.from).toBe(TODAY_START.toISOString());
    expect(overview.period.until).toBe(TODAY_END.toISOString());
    expect(overview.period.untilBizDate).toBe('2026-11-13');

    expect(overview.kpis.registeredUsers).toBe(6);
    expect(overview.kpis.members).toBe(5);
    expect(overview.kpis.newRegistrations).toEqual({
      count: 4,
      previousDay: '2026-11-12',
      previousDayCount: 1,
      delta: 3,
    });
    expect(overview.kpis.newMembers).toEqual({
      count: 3,
      previousDay: '2026-11-12',
      previousDayCount: 1,
      delta: 2,
    });

    expect(overview.kpis.wechatCash.cashInFen).toBe(5011n);
    expect(overview.kpis.wechatCash.cashRefundedFen).toBe(400n);
    expect(overview.kpis.wechatCash.netFen).toBe(4611n);
    expect(overview.composition.startup.payableFen).toBe(100100n);
    expect(overview.composition.mall.payableFen).toBe(12011n);
    expect(overview.composition.startup.orderCount).toBe(2);
    expect(overview.composition.mall.orderCount).toBe(3);
    expect(overview.composition.startup.itemQuantity).toBe(3);
    expect(overview.composition.mall.itemQuantity).toBe(6);
    expect(overview.composition.mall.pendingShipmentCount).toBe(2);
    expect(overview.composition.mall.shippedCount).toBe(1);
    expect(overview.composition.mall.closedCount).toBe(1);
    expect(overview.composition.startup.pendingShipmentCount).toBe(2);
    expect(overview.composition.cash).toEqual({
      wechatCashInFen: 5011n,
      wechatCashRefundedFen: 400n,
      netCashFen: 4611n,
      withdrawalPayoutFen: 9900n,
      cofounderActivationFen: 0n,
    });
    expect(overview.composition.cash.wechatCashInFen).toBe(5011n);

    const today = overview.trend.find((row) => row.bizDate === '2026-11-13');
    expect(today).toEqual({
      bizDate: '2026-11-13',
      startupPayableFen: 100100n,
      mallPayableFen: 12011n,
    });
    expect(overview.trend).toHaveLength(1);

    expect(overview.wallets.points).toEqual({ availableFen: 5000n, frozenFen: 3000n });
    expect(overview.wallets.withdrawable).toEqual({ availableFen: 10000n, frozenFen: 10000n });
    expect(overview.wallets.consumption).toEqual({ availableFen: 400n, frozenFen: 0n });
    expect(overview.wallets.withdrawalAppliedUnpaidFen).toBe(15000n);
    expect(overview.kpis.pendingWithdrawals).toEqual({ count: 2, amountFen: 15000n });
    expect(overview.withdrawals.completedPayouts).toEqual({
      count: 1,
      amountFen: 10000n,
      payoutFen: 9900n,
    });
    expect(overview.withdrawals.pendingRefunds).toEqual({ count: 1 });
    expect(overview.withdrawals.mutualExclusion).toEqual({
      withdrawalBlocksRefundUserCount: 2,
      refundBlocksWithdrawalUserCount: 1,
      bothPendingUserCount: 0,
    });
  });

  it('moves orders between today, yesterday, the last 7 days, and the calendar month', async () => {
    const yesterday = await ops.get({ period: 'yesterday' });
    expect(yesterday.composition.mall.payableFen).toBe(5000n);
    expect(yesterday.composition.startup.payableFen).toBe(0n);
    expect(yesterday.kpis.wechatCash).toEqual({
      cashInFen: 5000n,
      cashRefundedFen: 50n,
      netFen: 4950n,
    });
    expect(yesterday.composition.cash.withdrawalPayoutFen).toBe(3000n);

    const week = await ops.get({ period: 'last7days' });
    expect(week.composition.mall.payableFen).toBe(17011n);
    expect(week.trend).toHaveLength(7);
    expect(week.kpis.wechatCash.cashInFen).toBe(10011n);

    const month = await ops.get({ period: 'month' });
    expect(month.composition.mall.payableFen).toBe(17033n);
    expect(month.composition.startup.payableFen).toBe(100100n);
    expect(month.kpis.wechatCash).toEqual({
      cashInFen: 10033n,
      cashRefundedFen: 450n,
      netFen: 9583n,
    });
    expect(month.composition.cash.withdrawalPayoutFen).toBe(12900n);
    expect(month.withdrawals.completedPayouts).toEqual({
      count: 2,
      amountFen: 13000n,
      payoutFen: 12900n,
    });
    expect(month.trend).toHaveLength(30);
    expect(month.trend[0]?.bizDate).toBe('2026-11-01');
    expect(month.trend[29]?.bizDate).toBe('2026-11-30');

    const onlyYesterday = await ops.get({
      period: 'custom',
      from: '2026-11-12',
      to: '2026-11-12',
    });
    expect(onlyYesterday.composition.mall.payableFen).toBe(5000n);
    expect(onlyYesterday.composition.startup.payableFen).toBe(0n);
  });

  it('shows the filing queue and current-month qualifications without dividend amounts', async () => {
    const overview = await ops.get({});
    expect(overview.filing).toMatchObject({
      todayFiledCount: 2,
      todayBizDate: '2026-11-13',
      currentSequence: 5,
      nextLuckyReturnSequence: 10,
      nextLuckyReturnBeneficiarySequence: 2,
      backlogCount: 1,
      dailyCheckTime: '00:01',
    });
    expect(overview.filing.latestLuckyReturn).toMatchObject({
      triggerSequence: 5,
      beneficiarySequence: 1,
      pointsFen: 100000n,
      withdrawableFen: 20000n,
    });

    expect(overview.organization.seatedMembers).toBe(5);
    expect(overview.organization.nonMembers).toBe(1);
    expect(overview.organization.membersWithThreeMarkets).toBe(1);
    expect(overview.organization.positionQualifications.available).toBe(true);
    expect(overview.organization.positionQualifications.performanceMonth).toBe('2026-11');
    expect(overview.organization.positionQualifications.thresholdFen).toBe(100n);
    expect(overview.organization.positionQualifications.counts).toEqual([
      { positionCode: 'marketing_manager', positionName: '营销经理', qualifiedCount: 1 },
      { positionCode: 'senior_manager', positionName: '高级经理', qualifiedCount: 0 },
      { positionCode: 'director', positionName: '营销总监', qualifiedCount: 0 },
      { positionCode: 'senior_director', positionName: '高级总监', qualifiedCount: 0 },
      { positionCode: 'chief', positionName: '首席', qualifiedCount: 0 },
    ]);

    const json = toJsonSafe(overview) as {
      kpis: { wechatCash: { cashInFen: unknown } };
      filing: { latestLuckyReturn: { id: unknown; beneficiaryUserId: unknown } };
      organization: { positionQualifications: { thresholdFen: unknown } };
    };
    expect(json.kpis.wechatCash.cashInFen).toBe('5011');
    expect(typeof json.filing.latestLuckyReturn.id).toBe('string');
    expect(typeof json.filing.latestLuckyReturn.beneficiaryUserId).toBe('string');
    expect(json.organization.positionQualifications.thresholdFen).toBe('100');
    expect(JSON.stringify(json)).not.toMatch(/cost|profit|poolFen|shareFen|originalAmountFen/i);
  });
});

async function seed(db: ReturnType<typeof buildStage4>['db']): Promise<void> {
  const placedEarlier = new Date('2026-11-01T02:00:00.000Z');
  const parent = await user(db, '甲', true, placedEarlier);
  const childB = await user(db, '乙', true, TODAY_AT);
  const childC = await user(db, '丙', true, TODAY_AT);
  const childD = await user(db, '丁', true, TODAY_AT);
  const yesterdayMember = await user(db, '戊', true, YESTERDAY_AT);
  await user(db, '己', false, new Date('2026-11-13T06:00:00.000Z'));

  await seat(db, parent.id, null, `/${parent.id.toString()}/`, 0, placedEarlier);
  await seat(
    db,
    childB.id,
    parent.id,
    `/${parent.id.toString()}/${childB.id.toString()}/`,
    1,
    TODAY_AT,
  );
  await seat(
    db,
    childC.id,
    parent.id,
    `/${parent.id.toString()}/${childC.id.toString()}/`,
    1,
    TODAY_AT,
  );
  await seat(
    db,
    childD.id,
    parent.id,
    `/${parent.id.toString()}/${childD.id.toString()}/`,
    1,
    TODAY_AT,
  );
  await seat(db, yesterdayMember.id, null, `/${yesterdayMember.id.toString()}/`, 0, YESTERDAY_AT);

  const mallWallet = await order(db, {
    orderNo: 'M-WALLET',
    userId: childB.id,
    zone: 'mall',
    status: 'paid',
    payAmountFen: 10_000,
    freightFen: 500,
    wechatFen: 3_000,
    paidAt: TODAY_AT,
  });
  await item(db, mallWallet.id, 3);
  await item(db, mallWallet.id, 1);
  const shipped = await order(db, {
    orderNo: 'M-SHIP',
    userId: childC.id,
    zone: 'mall',
    status: 'shipped',
    payAmountFen: 2_000,
    wechatFen: 2_000,
    paidAt: new Date('2026-11-13T03:00:00.000Z'),
    shippedAt: new Date('2026-11-13T04:00:00.000Z'),
  });
  await item(db, shipped.id, 1);
  await order(db, {
    orderNo: 'M-YDAY',
    userId: yesterdayMember.id,
    zone: 'mall',
    status: 'paid',
    payAmountFen: 5_000,
    wechatFen: 5_000,
    paidAt: YESTERDAY_AT,
  });
  await order(db, {
    orderNo: 'M-PENDING',
    userId: childD.id,
    zone: 'mall',
    status: 'pending_payment',
    payAmountFen: 9_999,
    wechatFen: 9_999,
    paidAt: null,
  });
  const closed = await order(db, {
    orderNo: 'M-CLOSED',
    userId: childD.id,
    zone: 'mall',
    status: 'closed',
    payAmountFen: 8_000,
    wechatFen: 8_000,
    paidAt: null,
    closedAt: new Date('2026-11-13T05:00:00.000Z'),
  });
  const boundary = await order(db, {
    orderNo: 'M-START',
    userId: childB.id,
    zone: 'mall',
    status: 'paid',
    payAmountFen: 11,
    wechatFen: 11,
    paidAt: TODAY_START,
  });
  await item(db, boundary.id, 1);
  await order(db, {
    orderNo: 'M-NEXT-DAY',
    userId: childB.id,
    zone: 'mall',
    status: 'paid',
    payAmountFen: 22,
    wechatFen: 22,
    paidAt: TODAY_END,
  });
  await order(db, {
    orderNo: 'M-OCT',
    userId: childB.id,
    zone: 'mall',
    status: 'paid',
    payAmountFen: 33,
    wechatFen: 33,
    paidAt: BEFORE_MONTH,
  });
  await order(db, {
    orderNo: 'M-DEC',
    userId: childB.id,
    zone: 'mall',
    status: 'paid',
    payAmountFen: 44,
    wechatFen: 44,
    paidAt: MONTH_END,
  });
  const startupLarge = await order(db, {
    orderNo: 'S-LARGE',
    userId: childB.id,
    zone: 'startup',
    status: 'paid',
    payAmountFen: 100_000,
    wechatFen: 0,
    paidAt: new Date('2026-11-13T02:00:00.000Z'),
  });
  await item(db, startupLarge.id, 2);
  const startupSmall = await order(db, {
    orderNo: 'S-SMALL',
    userId: childC.id,
    zone: 'startup',
    status: 'paid',
    payAmountFen: 100,
    wechatFen: 0,
    paidAt: new Date('2026-11-13T02:30:00.000Z'),
  });
  await item(db, startupSmall.id, 1);

  await db.walletAccount.create({
    data: {
      userId: childB.id,
      walletType: 'points',
      balanceFen: 8_000n,
      frozenFen: 3_000n,
      updatedAt: TODAY_AT,
    },
  });
  await db.walletAccount.create({
    data: {
      userId: childB.id,
      walletType: 'withdrawable',
      balanceFen: 20_000n,
      frozenFen: 10_000n,
      updatedAt: TODAY_AT,
    },
  });
  await db.walletAccount.create({
    data: {
      userId: childC.id,
      walletType: 'consumption',
      balanceFen: 400n,
      frozenFen: 0n,
      updatedAt: TODAY_AT,
    },
  });

  await withdrawal(db, childB.id, 10_000n, 'pending', TODAY_AT);
  await withdrawal(db, yesterdayMember.id, 5_000n, 'pending', TODAY_AT);
  const paidOut = await withdrawal(db, parent.id, 10_000n, 'paid', TODAY_AT);
  await db.withdrawalSettlement.create({
    data: {
      applicationId: paidOut.id,
      userId: parent.id,
      outcome: 'paid',
      amountFen: 10_000n,
      feeFen: 100n,
      payoutFen: 9_900n,
      adminId: 1n,
      settledAt: TODAY_AT,
      createdAt: TODAY_AT,
    },
  });
  const paidYesterday = await withdrawal(db, parent.id, 3_000n, 'paid', YESTERDAY_AT);
  await db.withdrawalSettlement.create({
    data: {
      applicationId: paidYesterday.id,
      userId: parent.id,
      outcome: 'paid',
      amountFen: 3_000n,
      feeFen: 0n,
      payoutFen: 3_000n,
      adminId: 1n,
      settledAt: YESTERDAY_AT,
      createdAt: YESTERDAY_AT,
    },
  });
  await cash(db, CASH_WECHAT_REFUND, 400n, TODAY_AT, 'refund-today');
  await cash(db, CASH_WECHAT_REFUND, 50n, YESTERDAY_AT, 'refund-yesterday');
  await cash(db, CASH_WITHDRAWAL_PAYOUT, 9_900n, TODAY_AT, paidOut.id.toString());
  await cash(db, CASH_WITHDRAWAL_PAYOUT, 3_000n, YESTERDAY_AT, paidYesterday.id.toString());

  await db.orderRefund.create({
    data: {
      orderId: closed.id,
      userId: childD.id,
      status: 'pending',
      payAmountFen: 8_000,
      freightFen: 0,
      refundFen: null,
      deductionFen: null,
      wechatRefundFen: null,
      withdrawableDeductionFen: null,
      consumptionCreditFen: null,
      wechatRefundStatus: null,
      wechatRefundNo: null,
      appliedAt: TODAY_AT,
      decidedAt: null,
      decidedByAdminId: null,
      createdAt: TODAY_AT,
      updatedAt: TODAY_AT,
    },
  });

  const filed = await db.filing.create({
    data: {
      filingNo: 'F2026111300000001',
      userId: childB.id,
      orderId: startupLarge.id,
      subOrderId: null,
      sequence: 1,
      bizDate: '2026-11-13',
      status: 'settled',
      amountFen: 100_000,
      filedAt: TODAY_AT,
      settledAt: TODAY_AT,
      createdAt: TODAY_AT,
      updatedAt: TODAY_AT,
    },
  });
  await db.filing.create({
    data: {
      filingNo: 'F2026111300000002',
      userId: childC.id,
      orderId: startupSmall.id,
      subOrderId: null,
      sequence: 2,
      bizDate: '2026-11-13',
      status: 'filed',
      amountFen: 100,
      filedAt: TODAY_AT,
      settledAt: null,
      createdAt: TODAY_AT,
      updatedAt: TODAY_AT,
    },
  });
  await db.filing.create({
    data: {
      filingNo: 'F2026111200000004',
      userId: yesterdayMember.id,
      orderId: null,
      subOrderId: null,
      sequence: 4,
      bizDate: '2026-11-12',
      status: 'filed',
      amountFen: 100_000,
      filedAt: YESTERDAY_AT,
      settledAt: null,
      createdAt: YESTERDAY_AT,
      updatedAt: YESTERDAY_AT,
    },
  });
  await db.filingCounter.create({
    data: { slot: 1, lastSequence: 5, updatedAt: TODAY_AT },
  });
  await db.filingSettlement.create({
    data: {
      triggerSequence: 5,
      beneficiaryFilingId: filed.id,
      beneficiaryUserId: childB.id,
      pointsFen: 100_000n,
      withdrawableFen: 20_000n,
      unitPriceFen: 100_000,
      withdrawalRatioBps: 2_000,
      settledAt: TODAY_AT,
      createdAt: TODAY_AT,
    },
  });
  await db.startupSubOrder.create({
    data: {
      orderId: startupLarge.id,
      userId: childB.id,
      orderAt: TODAY_AT,
      paidAt: TODAY_AT,
      amountFen: 100_000,
      filedAt: null,
      createdAt: TODAY_AT,
    },
  });
  await db.startupSubOrder.create({
    data: {
      orderId: startupSmall.id,
      userId: childC.id,
      orderAt: TODAY_AT,
      paidAt: TODAY_AT,
      amountFen: 100,
      filedAt: TODAY_AT,
      createdAt: TODAY_AT,
    },
  });
  await db.marketThresholdRevision.create({
    data: {
      effectiveMonth: '2026-11',
      thresholdFen: 100n,
      updatedByAdminId: null,
      createdAt: TODAY_AT,
      updatedAt: TODAY_AT,
    },
  });
}

async function user(
  db: ReturnType<typeof buildStage4>['db'],
  nickname: string,
  seated: boolean,
  createdAt: Date,
): Promise<{ id: bigint }> {
  return db.user.create({
    data: {
      status: 'active',
      nickname,
      avatarUrl: null,
      phone: null,
      inviteCode: null,
      member: seated,
      seated,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

async function seat(
  db: ReturnType<typeof buildStage4>['db'],
  userId: bigint,
  parentUserId: bigint | null,
  path: string,
  depth: number,
  placedAt: Date,
): Promise<void> {
  await db.marketTreeNode.create({
    data: { userId, parentUserId, depth, path, placedAt },
  });
}

async function order(
  db: ReturnType<typeof buildStage4>['db'],
  input: {
    orderNo: string;
    userId: bigint;
    zone: string;
    status: string;
    payAmountFen: number;
    freightFen?: number;
    wechatFen: number;
    paidAt: Date | null;
    shippedAt?: Date;
    closedAt?: Date;
  },
): Promise<{ id: bigint }> {
  return db.order.create({
    data: {
      orderNo: input.orderNo,
      userId: input.userId,
      zone: input.zone,
      status: input.status,
      goodsTotalFen: input.payAmountFen - (input.freightFen ?? 0),
      freightFen: input.freightFen ?? 0,
      payAmountFen: input.payAmountFen,
      pvFen: 0,
      pointsFen: 0,
      withdrawableFen: 0,
      consumptionFen: 0,
      wechatFen: input.wechatFen,
      contactName: '收货人',
      contactPhone: '13800138000',
      province: '上海',
      city: '上海',
      district: '浦东',
      detail: '路 1 号',
      courierName: null,
      trackingNo: null,
      placedAt: input.paidAt ?? TODAY_AT,
      paidAt: input.paidAt,
      shippedAt: input.shippedAt ?? null,
      closedAt: input.closedAt ?? null,
      createdAt: TODAY_AT,
      updatedAt: TODAY_AT,
    },
  });
}

async function item(
  db: ReturnType<typeof buildStage4>['db'],
  orderId: bigint,
  quantity: number,
): Promise<void> {
  await db.orderItem.create({
    data: {
      orderId,
      skuId: 1n,
      productName: '商品',
      skuName: '规格',
      unitPriceFen: 1,
      pvFen: 0,
      freightFen: 0,
      quantity,
      lineTotalFen: quantity,
      createdAt: TODAY_AT,
    },
  });
}

async function withdrawal(
  db: ReturnType<typeof buildStage4>['db'],
  userId: bigint,
  amountFen: bigint,
  status: string,
  appliedAt: Date,
): Promise<{ id: bigint }> {
  return db.withdrawalApplication.create({
    data: {
      userId,
      amountFen,
      status,
      accountName: '甲',
      bankName: '银行',
      accountNo: '622200',
      branchName: '支行',
      appliedAt,
      createdAt: appliedAt,
      updatedAt: appliedAt,
    },
  });
}

async function cash(
  db: ReturnType<typeof buildStage4>['db'],
  bizType: string,
  amountFen: bigint,
  occurredAt: Date,
  bizId: string,
): Promise<void> {
  await db.cashLedgerEntry.create({
    data: {
      direction: CASH_OUTFLOW,
      amountFen,
      bizType,
      bizId,
      occurredAt,
      createdAt: occurredAt,
    },
  });
}
