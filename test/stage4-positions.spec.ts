import { BadRequestException, ConflictException } from '@nestjs/common';
import { graftMarket } from './support/stage2-harness';
import { buildStage4, type Stage4 } from './support/stage4-harness';

const JAN20 = new Date('2026-01-20T02:00:00.000Z');
const JAN15 = new Date('2026-01-15T02:00:00.000Z');
const FEB1 = new Date('2026-02-01T02:00:00.000Z');
const FEB10 = new Date('2026-02-10T02:00:00.000Z');
const FEB14 = new Date('2026-02-14T02:00:00.000Z');
const FEB20 = new Date('2026-02-20T02:00:00.000Z');
const MAR1 = new Date('2026-03-01T02:00:00.000Z');
const NOV13 = new Date('2026-11-13T04:00:00.000Z');

describe('stage 4 positions, team windows, and admin lookup', () => {
  async function boot(stage: Stage4): Promise<bigint> {
    await stage.users.onModuleInit();
    await stage.settings.onModuleInit();
    const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
    if (!root) {
      throw new Error('missing root');
    }
    return root.id;
  }

  it('keeps the current month on the old T and uses the new T next month', async () => {
    const stage = buildStage4(undefined, '100');
    const rootId = await boot(stage);
    stage.clock.current = JAN20;
    const user = insertUser(stage, '经理');
    graftMarket(stage.db, user, rootId, JAN20);
    for (const name of ['甲', '乙']) {
      const child = insertUser(stage, name);
      graftMarket(stage.db, child, user, JAN20);
      payStartup(stage, child, 150, JAN20);
    }
    const updated = await stage.settings.setMarketingManagerMarketThreshold('500000', 1n);
    expect(updated.month).toBe('2026-01');
    expect(updated.thresholdFen).toBe(100n);
    expect(updated.nextMonth).toBe('2026-02');
    expect(updated.nextThresholdFen).toBe(500_000n);

    stage.clock.current = FEB1;
    for (const child of stage.db.marketTreeNode.rows.filter((row) => row.parentUserId === user)) {
      payStartup(stage, child.userId as bigint, 150, FEB1);
    }
    stage.clock.current = MAR1;
    const january = await stage.positions.qualification(user, '2026-01');
    const february = await stage.positions.qualification(user, '2026-02');
    expect(january.ranks.find((rank) => rank.positionCode === 'marketing_manager')).toMatchObject({
      qualified: true,
      inPool: true,
    });
    expect(february.thresholdFen).toBe(500_000n);
    expect(february.ranks.find((rank) => rank.positionCode === 'marketing_manager')).toMatchObject({
      qualified: false,
      inPool: false,
    });
    expect(february.markets).toHaveLength(2);
    expect(february.markets.every((market) => market.performanceFen === 150n)).toBe(true);
  });

  it('excludes higher ranks from the 8% pool and does not redistribute a removed share', async () => {
    const stage = buildStage4(undefined, '100');
    const rootId = await boot(stage);
    stage.clock.current = JAN15;
    const senior = insertUser(stage, '高级');
    graftMarket(stage.db, senior, rootId, JAN15);
    const left = insertUser(stage, '左区');
    const right = insertUser(stage, '右区');
    graftMarket(stage.db, left, senior, JAN15);
    graftMarket(stage.db, right, senior, JAN15);
    const managers = [
      buildManager(stage, left, '甲', JAN15),
      buildManager(stage, left, '乙', JAN15),
      buildManager(stage, right, '丙', JAN15),
      buildManager(stage, right, '丁', JAN15),
    ];
    payMall(stage, rootId, 100_000, JAN15);
    const kept = managers[1];
    const removed = managers[0];
    if (kept === undefined || removed === undefined) {
      throw new Error('missing manager');
    }

    stage.clock.current = FEB10;
    const preview = await stage.positions.preview('2026-01');
    const managerPool = preview.pools.find((pool) => pool.positionCode === 'marketing_manager');
    const seniorPool = preview.pools.find((pool) => pool.positionCode === 'senior_manager');
    const directorPool = preview.pools.find((pool) => pool.positionCode === 'director');
    expect(preview.mallPvFen).toBe(100_000n);
    expect(preview.payoutDate).toBe('2026-02-15');
    expect(managerPool).toMatchObject({ poolFen: 8000n, eligibleCount: 6, shareFen: 1333n });
    expect(managerPool?.members.map((member) => member.userId).sort(compareId)).toEqual(
      [left, right, ...managers].sort(compareId),
    );
    expect(seniorPool).toMatchObject({ poolFen: 6000n, eligibleCount: 1, shareFen: 6000n });
    expect(seniorPool?.members.map((member) => member.userId)).toEqual([senior]);
    expect(directorPool).toMatchObject({ eligibleCount: 0, poolFen: 5000n, shareFen: 0n });

    await stage.positions.exclude('2026-01', removed, 1n);
    await expect(stage.positions.changePayoutDate('2026-01', '2026-02-10')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const moved = await stage.positions.changePayoutDate('2026-01', '2026-02-20');
    expect(moved.payoutDate).toBe('2026-02-20');
    const removedRow = moved.pools
      .find((pool) => pool.positionCode === 'marketing_manager')
      ?.members.find((member) => member.userId === removed);
    expect(removedRow).toMatchObject({ removed: true, originalAmountFen: 1333n });

    await stage.jobs.runDue();
    stage.clock.current = FEB14;
    await stage.jobs.runDue();
    expect(stage.db.positionDividendRecord.rows).toHaveLength(0);

    stage.clock.current = FEB20;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    const keptBalance = await stage.wallet.getBalances(kept);
    const seniorBalance = await stage.wallet.getBalances(senior);
    const removedBalance = await stage.wallet.getBalances(removed);
    expect(keptBalance.withdrawable.balanceFen).toBe(1134n);
    expect(keptBalance.points.balanceFen).toBe(133n);
    expect(keptBalance.consumption.balanceFen).toBe(66n);
    expect(seniorBalance.withdrawable.balanceFen).toBe(5100n);
    expect(seniorBalance.points.balanceFen).toBe(600n);
    expect(seniorBalance.consumption.balanceFen).toBe(300n);
    expect(removedBalance.withdrawable.balanceFen).toBe(0n);
    await expect(stage.positions.changePayoutDate('2026-01', '2026-02-25')).rejects.toBeInstanceOf(
      ConflictException,
    );

    await stage.positions.payManually(
      '2026-01',
      {
        userId: removed,
        positionCode: 'marketing_manager',
        actualAmountFen: 1000n,
        remark: '线下调整',
      },
      7n,
    );
    const manualBalance = await stage.wallet.getBalances(removed);
    expect(manualBalance.withdrawable.balanceFen).toBe(850n);
    expect(manualBalance.points.balanceFen).toBe(100n);
    expect(manualBalance.consumption.balanceFen).toBe(50n);
    expect(await stage.wallet.getBalances(kept)).toMatchObject({
      withdrawable: { balanceFen: 1134n },
    });
    await expect(
      stage.positions.payManually(
        '2026-01',
        {
          userId: removed,
          positionCode: 'marketing_manager',
          actualAmountFen: 1n,
          remark: '再次',
        },
        7n,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      stage.positions.payManually(
        '2026-01',
        {
          userId: kept,
          positionCode: 'marketing_manager',
          actualAmountFen: 1n,
          remark: '未移除',
        },
        7n,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const records = await stage.positions.listRecords('2026-01', 1, 50);
    expect(records.items.filter((item) => item.mode === 'auto')).toHaveLength(6);
    expect(records.items.filter((item) => item.mode === 'manual')).toEqual([
      expect.objectContaining({
        userId: removed,
        originalAmountFen: 1333n,
        actualAmountFen: 1000n,
        remark: '线下调整',
      }),
    ]);
    const adminWallets = await stage.walletAdmin.balances(senior);
    expect(adminWallets.withdrawable.balanceFen).toBe(5100n);
    const ledger = await stage.walletAdmin.ledger(senior, 'withdrawable', 1, 20);
    expect(ledger.items.some((item) => item.bizType === 'position_dividend')).toBe(true);

    const now = FEB20;
    stage.db.walletHold.create({
      data: {
        orderId: 1n,
        userId: senior,
        walletType: 'points',
        amountFen: 10n,
        status: 'held',
        createdAt: now,
        updatedAt: now,
      },
    });
    stage.db.consumptionTransfer.create({
      data: { payerUserId: senior, payeeUserId: kept, amountFen: 40n, createdAt: now },
    });
    const holds = await stage.walletAdmin.holds(senior, 'held', 1, 20);
    expect(holds.items).toEqual([expect.objectContaining({ amountFen: 10n, status: 'held' })]);
    const transfers = await stage.walletAdmin.transfers({ payerId: senior, page: 1, pageSize: 20 });
    expect(transfers.items).toEqual([
      expect.objectContaining({ payeeUserId: kept, amountFen: 40n, payerNickname: '高级' }),
    ]);
  });

  it('renames previously stored position titles to the official names', async () => {
    const stage = buildStage4();
    const now = stage.clock.current;
    stage.db.position.create({
      data: {
        code: 'senior_manager',
        name: '高级营销经理',
        rankLevel: 2,
        createdAt: now,
        updatedAt: now,
      },
    });
    stage.db.position.create({
      data: {
        code: 'director',
        name: '总监',
        rankLevel: 3,
        createdAt: now,
        updatedAt: now,
      },
    });
    await stage.positions.onModuleInit();
    expect(stage.db.position.rows.find((row) => row.code === 'senior_manager')?.name).toBe(
      '高级经理',
    );
    expect(stage.db.position.rows.find((row) => row.code === 'director')?.name).toBe('营销总监');
    expect(stage.db.position.rows.find((row) => row.code === 'marketing_manager')?.name).toBe(
      '营销经理',
    );
    expect(stage.db.position.rows.find((row) => row.code === 'senior_director')?.name).toBe(
      '高级总监',
    );
    expect(stage.db.position.rows.find((row) => row.code === 'chief')?.name).toBe('首席');
  });

  it('uses Shanghai calendar windows for the team page', async () => {
    const stage = buildStage4();
    const rootId = await boot(stage);
    stage.clock.current = NOV13;
    const child = insertUser(stage, '张三');
    graftMarket(stage.db, child, rootId, NOV13);
    payStartup(stage, child, 1, new Date('2026-11-13T01:00:00.000Z'));
    payStartup(stage, child, 2, new Date('2026-11-08T02:00:00.000Z'));
    payStartup(stage, child, 4, new Date('2026-11-01T02:00:00.000Z'));
    payStartup(stage, child, 8, new Date('2026-10-31T15:00:00.000Z'));
    const team = await stage.team.getForUser(rootId);
    expect(team.marketCount).toBe(1);
    expect(team.markets[0]).toEqual({
      name: '张三',
      monthPerformanceFen: 7n,
      recent7DaysPerformanceFen: 3n,
      todayPerformanceFen: 1n,
    });
    expect(team.totalPerformanceFen).toBe(7n);
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

function buildManager(stage: Stage4, parentId: bigint, name: string, paidAt: Date): bigint {
  const manager = insertUser(stage, name);
  graftMarket(stage.db, manager, parentId, paidAt);
  for (const side of ['左', '右']) {
    const leaf = insertUser(stage, `${name}${side}`);
    graftMarket(stage.db, leaf, manager, paidAt);
    payStartup(stage, leaf, 100, paidAt);
  }
  return manager;
}

function payStartup(stage: Stage4, userId: bigint, amount: number, paidAt: Date): void {
  const seq = stage.db.order.rows.length + 1;
  stage.db.order.create({
    data: {
      orderNo: `S${seq}`,
      userId,
      zone: 'startup',
      status: 'paid',
      goodsTotalFen: amount,
      freightFen: 0,
      payAmountFen: amount,
      pvFen: 0,
      pointsFen: 0,
      withdrawableFen: 0,
      consumptionFen: 0,
      wechatFen: 0,
      contactName: '张三',
      contactPhone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文三路',
      courierName: null,
      trackingNo: null,
      placedAt: paidAt,
      paidAt,
      shippedAt: null,
      closedAt: null,
      createdAt: paidAt,
      updatedAt: paidAt,
    },
  });
}

function payMall(stage: Stage4, userId: bigint, pvFen: number, paidAt: Date): void {
  stage.db.order.create({
    data: {
      orderNo: `M${stage.db.order.rows.length + 1}`,
      userId,
      zone: 'mall',
      status: 'paid',
      goodsTotalFen: pvFen,
      freightFen: 0,
      payAmountFen: pvFen,
      pvFen,
      pointsFen: 0,
      withdrawableFen: 0,
      consumptionFen: 0,
      wechatFen: 0,
      contactName: '张三',
      contactPhone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文三路',
      courierName: null,
      trackingNo: null,
      placedAt: paidAt,
      paidAt,
      shippedAt: null,
      closedAt: null,
      createdAt: paidAt,
      updatedAt: paidAt,
    },
  });
}

function compareId(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
