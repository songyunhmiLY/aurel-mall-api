import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { LockedRuntimeConfig } from '../src/config/locked-runtime';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { USER_STATUS_DISABLED } from '../src/common/auth/user-status';
import { UpdateWelfareEntryDto } from '../src/modules/rewards/red-packet/dto/update-welfare-entry.dto';
import {
  describeWelfareQuota,
  splitPool,
} from '../src/modules/rewards/red-packet/red-packet.policy';
import { buildStage4, stage4Locked, type Stage4 } from './support/stage4-harness';

const APR1_1000 = new Date('2026-04-01T02:00:00.000Z');
const APR1_1500 = new Date('2026-04-01T07:00:00.000Z');
const APR1_2359 = new Date('2026-04-01T15:59:00.000Z');
const APR2_0030 = new Date('2026-04-01T16:00:30.000Z');
const APR2_0100 = new Date('2026-04-01T16:01:00.000Z');
const APR2_1000 = new Date('2026-04-02T02:00:00.000Z');
const APR3_0100 = new Date('2026-04-02T16:01:00.000Z');

function welfareLocked(overrides: Partial<LockedRuntimeConfig> = {}): LockedRuntimeConfig {
  return Object.freeze({
    ...stage4Locked(100),
    filingWithdrawalRatioBps: 0,
    startupSalesRatioBps: 0,
    startupPointRatioBps: 0,
    mallSalesRatioBps: 0,
    mallPointRatioBps: 0,
    redPacketDailyAccrualBps: 300,
    redPacketRoundPayThresholdFen: 300,
    redPacketRoundClaimCapFen: 80_000,
    ...overrides,
  });
}

describe('welfare red packet quota math', () => {
  it('opens a round for every full K of WeChat actual pay and keeps claimed continuous', () => {
    expect(describeWelfareQuota(499_999n, 0n, 500_000, 800_000).openedRoundCount).toBe(0n);
    expect(describeWelfareQuota(499_999n, 0n, 500_000, 800_000).moneyEligible).toBe(false);

    const one = describeWelfareQuota(500_000n, 0n, 500_000, 800_000);
    expect(one.openedRoundCount).toBe(1n);
    expect(one.claimCapFen).toBe(800_000n);
    expect(one.moneyEligible).toBe(true);
    expect(one.currentRoundNo).toBe(1n);
    expect(one.currentRoundClaimedFen).toBe(0n);

    const two = describeWelfareQuota(1_000_000n, 900_000n, 500_000, 800_000);
    expect(two.openedRoundCount).toBe(2n);
    expect(two.claimCapFen).toBe(1_600_000n);
    expect(two.moneyEligible).toBe(true);
    expect(two.currentRoundNo).toBe(2n);
    expect(two.currentRoundClaimedFen).toBe(100_000n);

    const filled = describeWelfareQuota(500_000n, 800_000n, 500_000, 800_000);
    expect(filled.moneyEligible).toBe(false);
    expect(filled.currentRoundNo).toBe(1n);
    expect(filled.currentRoundClaimedFen).toBe(800_000n);

    const spilled = describeWelfareQuota(500_000n, 900_000n, 500_000, 800_000);
    expect(spilled.moneyEligible).toBe(false);
    expect(spilled.openedRoundCount).toBe(1n);
    expect(spilled.currentRoundNo).toBe(2n);
    expect(spilled.currentRoundClaimedFen).toBe(100_000n);
  });

  it('does not open a round when K is 0', () => {
    const quota = describeWelfareQuota(500_000n, 0n, 0, 800_000);
    expect(quota.openedRoundCount).toBe(0n);
    expect(quota.moneyEligible).toBe(false);
  });

  it('leaves undistributed fen with the system and never over-allocates the pool', () => {
    expect(splitPool(100n, 300, 0)).toEqual({
      poolFen: 3n,
      shareFen: 0n,
      distributedFen: 0n,
      remainderFen: 3n,
    });
    const split = splitPool(500n, 300, 2);
    expect(split).toEqual({
      poolFen: 15n,
      shareFen: 7n,
      distributedFen: 14n,
      remainderFen: 1n,
    });
    expect(split.distributedFen <= split.poolFen).toBe(true);
  });
});

describe('welfare red packet', () => {
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

  async function pay(stage: Stage4, userId: bigint, orderId: bigint): Promise<void> {
    const result = await stage.orders.pay(userId, orderId);
    if (result.wechat) {
      await stage.wechatPay.simulateSuccess(result.wechat.payNo);
    }
  }

  async function buyStartup(
    stage: Stage4,
    userId: bigint,
    productId: bigint,
    quantity: number,
  ): Promise<bigint> {
    const addressId = await addressOf(stage, userId);
    const created = await stage.orders.create(userId, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId, quantity }],
    });
    await pay(stage, userId, created.id);
    return created.id;
  }

  function packetCredits(stage: Stage4, userId: bigint) {
    return stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === userId && row.bizType === 'red_packet',
    );
  }

  it('counts only startup WeChat cash toward eligibility and rejects anyone who is not eligible', async () => {
    const stage = buildStage4(welfareLocked());
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'mix', rootId);
    await expect(stage.redPackets.signup(buyer)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(stage.redPackets.signup(buyer)).rejects.toThrow('不具备资格');

    const product = await startupProduct(stage, '创业装', 10);
    await credit(stage, buyer, 'points', 100);
    const walletOrderId = await buyStartup(stage, buyer, product.id, 1);
    const walletOrder = stage.db.order.rows.find((row) => row.id === walletOrderId);
    expect(walletOrder?.wechatFen).toBe(0);
    expect(walletOrder?.goodsTotalFen).toBe(100);
    expect(stage.db.user.rows.find((row) => row.id === buyer)?.member).toBe(true);
    expect(await stage.redPackets.statusFor(buyer)).toEqual({
      eligible: false,
      signedUpToday: false,
    });
    await expect(stage.redPackets.signup(buyer)).rejects.toThrow('不具备资格');

    const mall = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '礼盒',
      freightFen: 0,
      priceFen: 5_000,
      pvFen: 1,
      stockQuantity: 2,
      status: 'on',
    });
    const addressId = stage.db.userAddress.rows.find((row) => row.userId === buyer)?.id;
    if (addressId === undefined) {
      throw new Error('missing address');
    }
    const mallOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: mall.product.id, quantity: 1 }],
    });
    await pay(stage, buyer, mallOrder.id);
    expect(stage.db.order.rows.find((row) => row.id === mallOrder.id)?.wechatFen).toBe(5_000);
    expect(await stage.redPackets.statusFor(buyer)).toEqual({
      eligible: false,
      signedUpToday: false,
    });

    stage.clock.current = APR1_1500;
    const cashOrderId = await buyStartup(stage, buyer, product.id, 1);
    expect(stage.db.order.rows.find((row) => row.id === cashOrderId)?.wechatFen).toBe(100);
    expect(await stage.redPackets.quoteFor(buyer)).toMatchObject({
      actualPayFen: 100n,
      moneyEligible: false,
    });

    const second = await buyStartup(stage, buyer, product.id, 2);
    expect(stage.db.order.rows.find((row) => row.id === second)?.wechatFen).toBe(200);
    const status = await stage.redPackets.statusFor(buyer);
    expect(status).toEqual({ eligible: true, signedUpToday: false });
    expect(Object.keys(status).sort()).toEqual(['eligible', 'signedUpToday']);

    expect(await stage.redPackets.signup(buyer)).toEqual({
      eligible: true,
      signedUpToday: true,
    });
    expect(await stage.redPackets.signup(buyer)).toEqual({
      eligible: true,
      signedUpToday: true,
    });
    expect(stage.db.redPacketSignup.rows.filter((row) => row.userId === buyer)).toHaveLength(1);

    const user = stage.db.user.rows.find((row) => row.id === buyer);
    if (!user) {
      throw new Error('missing buyer');
    }
    user.status = USER_STATUS_DISABLED;
    await expect(stage.redPackets.signup(buyer)).rejects.toBeInstanceOf(UnauthorizedException);
    user.status = 'active';

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    const accrual = stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01');
    expect(accrual).toMatchObject({
      startupSalesFen: 400n,
      accrualFen: 12n,
      signupCount: 1,
      shareFen: 12n,
      distributedFen: 12n,
      remainderFen: 0n,
    });
    expect(accrual?.settledAt).toBeInstanceOf(Date);
    expect(packetCredits(stage, buyer)).toEqual([
      expect.objectContaining({
        walletType: 'withdrawable',
        direction: 'credit',
        amountFen: 12n,
        sourceCode: 'red_packet',
      }),
    ]);
    expect(
      stage.db.rewardLedgerEntry.rows.filter((row) => row.rewardType === 'red_packet'),
    ).toHaveLength(1);
  });

  it('keeps accumulating the WeChat leg across days when one order mixes wallet and WeChat', async () => {
    const stage = buildStage4(welfareLocked({ redPacketRoundPayThresholdFen: 200 }));
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'span', rootId);
    const product = await startupProduct(stage, '跨天', 6);
    await credit(stage, buyer, 'points', 100);
    const mixedId = await buyStartup(stage, buyer, product.id, 2);
    const mixed = stage.db.order.rows.find((row) => row.id === mixedId);
    expect(mixed).toMatchObject({ pointsFen: 100, wechatFen: 100, goodsTotalFen: 200 });
    expect(await stage.redPackets.statusFor(buyer)).toEqual({
      eligible: false,
      signedUpToday: false,
    });

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01'),
    ).toMatchObject({ startupSalesFen: 200n, signupCount: 0, remainderFen: 6n });

    stage.clock.current = APR2_1000;
    await buyStartup(stage, buyer, product.id, 1);
    const quote = await stage.redPackets.quoteFor(buyer);
    expect(quote.actualPayFen).toBe(200n);
    expect(quote.openedRoundCount).toBe(1n);
    expect(await stage.redPackets.statusFor(buyer)).toEqual({
      eligible: true,
      signedUpToday: false,
    });

    stage.clock.current = APR3_0100;
    await stage.jobs.runDue();
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-02'),
    ).toMatchObject({ startupSalesFen: 100n, signupCount: 0, remainderFen: 3n });
    expect(stage.db.redPacketPayout.rows).toHaveLength(0);
  });

  it('splits the goods-amount pool equally and does not pay more because someone opened more rounds', async () => {
    const stage = buildStage4(welfareLocked({ redPacketRoundPayThresholdFen: 100 }));
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const small = await loginBuyer(stage, 'small', rootId);
    const large = await loginBuyer(stage, 'large', rootId);
    const product = await startupProduct(stage, '均分', 10);
    await buyStartup(stage, small, product.id, 1);
    await buyStartup(stage, large, product.id, 4);
    await stage.redPackets.signup(small);
    await stage.redPackets.signup(large);

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    expect(packetCredits(stage, small).map((row) => row.amountFen)).toEqual([7n]);
    expect(packetCredits(stage, large).map((row) => row.amountFen)).toEqual([7n]);
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01'),
    ).toMatchObject({
      startupSalesFen: 500n,
      accrualFen: 15n,
      signupCount: 2,
      shareFen: 7n,
      distributedFen: 14n,
      remainderFen: 1n,
    });
    const largeQuote = await stage.redPackets.quoteFor(large);
    expect(largeQuote.openedRoundCount).toBe(4n);
    expect(largeQuote.cumulativeClaimedFen).toBe(7n);
  });

  it('keeps the whole pool when nobody signed up', async () => {
    const stage = buildStage4(welfareLocked({ redPacketRoundPayThresholdFen: 100 }));
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'silent', rootId);
    const product = await startupProduct(stage, '无人报名', 4);
    await buyStartup(stage, buyer, product.id, 1);
    expect((await stage.redPackets.statusFor(buyer)).eligible).toBe(true);

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    expect(packetCredits(stage, buyer)).toHaveLength(0);
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01'),
    ).toMatchObject({
      startupSalesFen: 100n,
      accrualFen: 3n,
      signupCount: 0,
      shareFen: 0n,
      distributedFen: 0n,
      remainderFen: 3n,
    });
    expect((await stage.redPackets.statusFor(buyer)).eligible).toBe(true);
  });

  it('pays the full share when it exceeds the remaining cap and pauses until another round opens', async () => {
    const stage = buildStage4(
      welfareLocked({
        redPacketDailyAccrualBps: 10_000,
        redPacketRoundPayThresholdFen: 100,
        redPacketRoundClaimCapFen: 80,
      }),
    );
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'over', rootId);
    const product = await startupProduct(stage, '超额', 4);
    await buyStartup(stage, buyer, product.id, 1);
    await stage.redPackets.signup(buyer);

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    expect(packetCredits(stage, buyer)).toEqual([
      expect.objectContaining({
        walletType: 'withdrawable',
        amountFen: 100n,
        sourceCode: 'red_packet',
      }),
    ]);
    expect(packetCredits(stage, buyer).some((row) => row.walletType !== 'withdrawable')).toBe(
      false,
    );
    expect(await stage.redPackets.statusFor(buyer)).toEqual({
      eligible: false,
      signedUpToday: false,
    });
    await expect(stage.redPackets.signup(buyer)).rejects.toThrow('不具备资格');

    const paused = await stage.welfareAdmin.listParticipants({
      userId: buyer,
      page: 1,
      pageSize: 20,
    });
    expect(paused.items[0]).toMatchObject({
      userId: buyer,
      eligible: false,
      actualPayFen: 100n,
      openedRoundCount: 1,
      claimCapFen: 80n,
      cumulativeClaimedFen: 100n,
      currentRoundNo: 2,
      currentRoundClaimedFen: 20n,
      signedUpToday: false,
    });
    expect(Object.keys(await stage.redPackets.statusFor(buyer)).sort()).toEqual([
      'eligible',
      'signedUpToday',
    ]);

    stage.clock.current = APR2_1000;
    // 红包已经进入可提现账户。再买 2 件时，其中 1 件会被可提现账户抵掉，只有微信支付的那一件计入实付。
    await buyStartup(stage, buyer, product.id, 2);
    expect(await stage.redPackets.statusFor(buyer)).toEqual({
      eligible: true,
      signedUpToday: false,
    });
    const resumed = await stage.redPackets.quoteFor(buyer);
    expect(resumed.actualPayFen).toBe(200n);
    expect(resumed.openedRoundCount).toBe(2n);
    expect(resumed.claimCapFen).toBe(160n);
    expect(resumed.cumulativeClaimedFen).toBe(100n);
    expect(resumed.currentRoundClaimedFen).toBe(20n);
    expect(await stage.redPackets.signup(buyer)).toEqual({
      eligible: true,
      signedUpToday: true,
    });
  });

  it('keeps eligibility when the overshoot already fits inside an opened later round', async () => {
    const stage = buildStage4(
      welfareLocked({
        redPacketDailyAccrualBps: 10_000,
        redPacketRoundPayThresholdFen: 100,
        redPacketRoundClaimCapFen: 150,
      }),
    );
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'room', rootId);
    const product = await startupProduct(stage, '已开下一轮', 4);
    await buyStartup(stage, buyer, product.id, 2);
    await stage.redPackets.signup(buyer);

    stage.clock.current = APR2_1000;
    await stage.jobs.runDue();
    expect(packetCredits(stage, buyer).map((row) => row.amountFen)).toEqual([200n]);
    const quote = await stage.redPackets.quoteFor(buyer);
    expect(quote.openedRoundCount).toBe(2n);
    expect(quote.claimCapFen).toBe(300n);
    expect(quote.cumulativeClaimedFen).toBe(200n);
    expect(quote.currentRoundNo).toBe(2n);
    expect(quote.currentRoundClaimedFen).toBe(50n);
    expect(quote.moneyEligible).toBe(true);
    expect(await stage.redPackets.signup(buyer)).toEqual({
      eligible: true,
      signedUpToday: true,
    });
  });

  it('uses goods amount for the pool and ignores freight and mall sales', async () => {
    const stage = buildStage4(
      welfareLocked({
        redPacketDailyAccrualBps: 10_000,
        redPacketRoundPayThresholdFen: 100,
      }),
    );
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'freight', rootId);
    const product = await startupProduct(stage, '含运费', 4, 40);
    const orderId = await buyStartup(stage, buyer, product.id, 1);
    const order = stage.db.order.rows.find((row) => row.id === orderId);
    expect(order?.goodsTotalFen).toBe(100);
    expect(order?.payAmountFen).toBe(140);
    expect(order?.wechatFen).toBe(140);
    await stage.redPackets.signup(buyer);

    const mall = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '商城',
      freightFen: 0,
      priceFen: 900,
      pvFen: 1,
      stockQuantity: 2,
      status: 'on',
    });
    const addressId = stage.db.userAddress.rows.find((row) => row.userId === buyer)?.id;
    if (addressId === undefined) {
      throw new Error('missing address');
    }
    const mallOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: mall.product.id, quantity: 1 }],
    });
    await pay(stage, buyer, mallOrder.id);

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01'),
    ).toMatchObject({ startupSalesFen: 100n, accrualFen: 100n, shareFen: 100n });
    expect(packetCredits(stage, buyer).map((row) => row.amountFen)).toEqual([100n]);
    expect((await stage.redPackets.quoteFor(buyer)).actualPayFen).toBe(140n);
  });

  it('settles the previous Shanghai day at 00:01, ignores the new day, and does not pay twice', async () => {
    const stage = buildStage4(welfareLocked({ redPacketRoundPayThresholdFen: 100 }));
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const early = await loginBuyer(stage, 'early', rootId);
    const late = await loginBuyer(stage, 'late', rootId);
    const product = await startupProduct(stage, '日切', 4);
    await buyStartup(stage, early, product.id, 1);
    await buyStartup(stage, late, product.id, 1);

    stage.clock.current = APR1_2359;
    await stage.redPackets.signup(early);
    expect(stage.db.redPacketSignup.rows.find((row) => row.userId === early)?.bizDate).toBe(
      '2026-04-01',
    );

    stage.clock.current = APR2_0030;
    await stage.redPackets.signup(late);
    expect(stage.db.redPacketSignup.rows.find((row) => row.userId === late)?.bizDate).toBe(
      '2026-04-02',
    );
    await stage.jobs.runDue();
    expect(packetCredits(stage, early)).toHaveLength(0);
    expect(packetCredits(stage, late)).toHaveLength(0);
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01')?.settledAt,
    ).toBeUndefined();

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    expect(packetCredits(stage, early).map((row) => row.amountFen)).toEqual([6n]);
    expect(packetCredits(stage, late)).toHaveLength(0);
    expect(stage.db.redPacketPayout.rows).toHaveLength(1);
    const listed = await stage.welfareAdmin.listSignups({ page: 1, pageSize: 20 });
    expect(listed.total).toBe(2);
    const earlyRow = listed.items.find((item) => item.userId === early);
    const lateRow = listed.items.find((item) => item.userId === late);
    expect(earlyRow).toMatchObject({ bizDate: '2026-04-01', settled: true, payoutFen: 6n });
    expect(lateRow).toMatchObject({ bizDate: '2026-04-02', settled: false, payoutFen: null });

    stage.clock.current = APR3_0100;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    expect(packetCredits(stage, early).map((row) => row.amountFen)).toEqual([6n]);
    expect(packetCredits(stage, late)).toHaveLength(0);
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-02'),
    ).toMatchObject({ signupCount: 1, startupSalesFen: 0n, accrualFen: 0n, shareFen: 0n });
  });

  it('catches up a missed day without distributing a day that had no signups', async () => {
    const stage = buildStage4(
      welfareLocked({
        redPacketDailyAccrualBps: 10_000,
        redPacketRoundPayThresholdFen: 100,
      }),
    );
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'catchup', rootId);
    const product = await startupProduct(stage, '补跑', 4);
    await buyStartup(stage, buyer, product.id, 1);
    await stage.redPackets.signup(buyer);

    stage.clock.current = APR3_0100;
    await stage.jobs.runDue();
    expect(packetCredits(stage, buyer)).toHaveLength(1);
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01'),
    ).toMatchObject({ signupCount: 1, distributedFen: 100n });
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-02'),
    ).toMatchObject({ signupCount: 0, distributedFen: 0n, remainderFen: 0n });
    expect(stage.db.redPacketPayout.rows).toHaveLength(1);
  });

  it('uses the admin pool override on the configured day and rejects settled days', async () => {
    const stage = buildStage4(welfareLocked({ redPacketRoundPayThresholdFen: 100 }));
    const rootId = await boot(stage);
    stage.clock.current = APR1_1000;
    const buyer = await loginBuyer(stage, 'pool', rootId);
    const product = await startupProduct(stage, '指定池', 6);
    await buyStartup(stage, buyer, product.id, 3);
    await stage.redPackets.signup(buyer);

    await expect(
      stage.welfareAdmin.setPoolOverride({ bizDate: 'no-date', amountFen: '500' }, 7n),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      stage.welfareAdmin.setPoolOverride({ bizDate: '2026-04-01', amountFen: '-5' }, 7n),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      await stage.welfareAdmin.setPoolOverride({ bizDate: '2026-04-01', amountFen: '500' }, 7n),
    ).toMatchObject({ bizDate: '2026-04-01', amountFen: 500n, settled: false });
    // 同一天重复设置会覆盖旧金额。
    expect(
      await stage.welfareAdmin.setPoolOverride({ bizDate: '2026-04-01', amountFen: '700' }, 7n),
    ).toMatchObject({ amountFen: 700n });

    stage.clock.current = APR2_0100;
    await stage.jobs.runDue();
    expect(
      stage.db.redPacketDailyAccrual.rows.find((row) => row.bizDate === '2026-04-01'),
    ).toMatchObject({ startupSalesFen: 300n, accrualFen: 700n, signupCount: 1, shareFen: 700n });
    expect(packetCredits(stage, buyer).map((row) => row.amountFen)).toEqual([700n]);

    await expect(
      stage.welfareAdmin.setPoolOverride({ bizDate: '2026-04-01', amountFen: '900' }, 7n),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await stage.welfareAdmin.listPoolOverrides()).toMatchObject([
      { bizDate: '2026-04-01', amountFen: 700n, settled: true },
    ]);

    await stage.welfareAdmin.deletePoolOverride('2026-04-01');
    expect(await stage.welfareAdmin.listPoolOverrides()).toEqual([]);
    await expect(stage.welfareAdmin.deletePoolOverride('2026-04-01')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('stores the home entry in admin settings and keeps K, C, and the rate out of that write', async () => {
    const stage = buildStage4(welfareLocked());
    await boot(stage);
    expect(await stage.welfareAdmin.getEntry()).toEqual({ copy: '', imageUrl: null });
    expect(
      await stage.welfareAdmin.setEntry(
        { copy: '  抢红包  ', imageUrl: ' https://cdn.example.com/welfare.png ' },
        1n,
      ),
    ).toEqual({ copy: '抢红包', imageUrl: 'https://cdn.example.com/welfare.png' });
    expect(await stage.welfareAdmin.getEntry()).toEqual({
      copy: '抢红包',
      imageUrl: 'https://cdn.example.com/welfare.png',
    });
    expect(await stage.welfareAdmin.setEntry({ copy: '抢红包', imageUrl: '   ' }, 1n)).toEqual({
      copy: '抢红包',
      imageUrl: null,
    });
    const keys = stage.db.adminSetting.rows.map((row) => row.settingKey);
    expect(keys).toEqual(expect.arrayContaining(['welfare_entry_copy', 'welfare_entry_image_url']));
    expect(keys).not.toEqual(
      expect.arrayContaining([
        'RED_PACKET_DAILY_ACCRUAL_BPS',
        'RED_PACKET_ROUND_PAY_THRESHOLD_FEN',
        'RED_PACKET_ROUND_CLAIM_CAP_FEN',
      ]),
    );

    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        {
          copy: '抢红包',
          imageUrl: 'https://cdn.example.com/welfare.png',
          redPacketRoundPayThresholdFen: 1,
        },
        { type: 'body', metatype: UpdateWelfareEntryDto, data: '' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
