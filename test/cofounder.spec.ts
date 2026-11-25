import { generateKeyPairSync } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { LockedRuntimeConfig } from '../src/config/locked-runtime';
import { latestDueSlot } from '../src/modules/cofounder/cofounder-schedule';
import { splitEvenly } from '../src/modules/cofounder/cofounder-split';
import type { CofounderSettings } from '../src/modules/cofounder/cofounder.constants';
import { UpdateCofounderSettingsDto } from '../src/modules/cofounder/dto/update-cofounder-settings.dto';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { OpsOverviewService } from '../src/modules/ops/ops-overview.service';
import type { WechatPayCredentials } from '../src/modules/payments/wechat-pay-settings.service';
import { CASH_COFOUNDER_ACTIVATION, CASH_INFLOW } from '../src/modules/wallet/wallet.constants';
import { buildStage4, stage4Locked, type Stage4 } from './support/stage4-harness';

const APR1_NOON = new Date('2026-04-01T04:00:00.000Z');
const APR2_BEFORE = new Date('2026-04-01T16:00:59.000Z');
const APR2_AT = new Date('2026-04-01T16:01:00.000Z');

function ratios(startup: number, mall: number, unitPriceFen = 10_000): LockedRuntimeConfig {
  return Object.freeze({
    ...stage4Locked(unitPriceFen),
    startupSalesRatioBps: 0,
    startupPointRatioBps: 0,
    mallSalesRatioBps: 0,
    mallPointRatioBps: 0,
    filingWithdrawalRatioBps: 0,
    cofounderDividendRatioBps: startup,
    cofounderStartupDividendRatioBps: startup,
    cofounderMallDividendRatioBps: mall,
  });
}

function schedule(
  overrides: Partial<CofounderSettings['schedule']> = {},
): CofounderSettings['schedule'] {
  return {
    cycle: 'daily',
    time: '00:01',
    weekday: 1,
    monthDay: 1,
    intervalDays: 7,
    anchorDate: '2026-01-01',
    ...overrides,
  };
}

function config(overrides: Partial<CofounderSettings> = {}): CofounderSettings {
  return {
    seatCap: 100,
    userButtonOpen: true,
    activationAmountFen: 8_800n,
    payoutMode: 'immediate',
    poolThresholdFen: 0n,
    perPersonThresholdFen: 0n,
    ...overrides,
    schedule: overrides.schedule ?? schedule(),
  };
}

describe('cofounder split and schedule', () => {
  it('never over-allocates an equal split', () => {
    expect(splitEvenly(10n, 3)).toEqual({ shareFen: 3n, distributedFen: 9n, retainedFen: 1n });
    expect(splitEvenly(20001n, 2)).toEqual({
      shareFen: 10000n,
      distributedFen: 20000n,
      retainedFen: 1n,
    });
    expect(splitEvenly(500n, 0).retainedFen).toBe(500n);
    expect(splitEvenly(500n, 0).distributedFen).toBe(0n);
  });

  it('uses the Shanghai clock for daily, weekly, monthly, and interval slots', () => {
    const dailyBefore = latestDueSlot(APR2_BEFORE, schedule({ cycle: 'daily', time: '00:01' }));
    const dailyAt = latestDueSlot(APR2_AT, schedule({ cycle: 'daily', time: '00:01' }));
    expect(dailyBefore?.key).toBe('daily:2026-04-01');
    expect(dailyAt?.key).toBe('daily:2026-04-02');

    const weekly = latestDueSlot(
      APR1_NOON,
      schedule({ cycle: 'weekly', weekday: 1, time: '00:00' }),
    );
    expect(weekly?.key).toBe('weekly:2026-03-30');

    const february = latestDueSlot(
      new Date('2026-02-28T04:00:00.000Z'),
      schedule({ cycle: 'monthly', monthDay: 31, time: '00:00' }),
    );
    expect(february?.key).toBe('monthly:2026-02-28');

    const interval = latestDueSlot(
      APR1_NOON,
      schedule({ cycle: 'interval', intervalDays: 10, anchorDate: '2026-03-01', time: '09:00' }),
    );
    expect(interval?.key).toBe('interval:2026-03-31');
    expect(
      latestDueSlot(
        new Date('2026-02-28T00:00:00.000Z'),
        schedule({ cycle: 'interval', intervalDays: 10, anchorDate: '2026-03-01', time: '09:00' }),
      ),
    ).toBeNull();
  });
});

describe('cofounder identity and dividends', () => {
  async function boot(stage: Stage4): Promise<bigint> {
    await stage.users.onModuleInit();
    const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
    if (!root) {
      throw new Error('missing root');
    }
    return root.id;
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
    expect(Object.keys(session.user).sort()).toEqual([
      'avatarUrl',
      'id',
      'inviteCode',
      'member',
      'nickname',
      'phone',
      'status',
    ]);
    const inviter = stage.db.user.rows.find((row) => row.id === inviterUserId);
    if (typeof inviter?.inviteCode !== 'string' || inviter.inviteCode.length === 0) {
      throw new Error('missing invite code');
    }
    await stage.users.bindInviter(session.user.id, inviter.inviteCode);
    return session.user.id;
  }

  async function pay(stage: Stage4, userId: bigint, orderId: bigint): Promise<void> {
    const result = await stage.orders.pay(userId, orderId);
    if (result.wechat) {
      await stage.wechatPay.simulateSuccess(result.wechat.payNo);
    }
  }

  async function startupProduct(stage: Stage4, stock: number, freightFen = 0) {
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen,
      stockQuantity: stock,
      status: 'on',
    });
    return created.product.id;
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

  function cofounderCredits(stage: Stage4, userId: bigint) {
    return stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === userId && row.bizType === 'cofounder' && row.direction === 'credit',
    );
  }

  async function accrueStartup(
    stage: Stage4,
    userId: bigint,
    orderId: bigint,
    goodsTotalFen: number,
  ): Promise<void> {
    await stage.db.$transaction(async (tx) => {
      await stage.cofounderDividend.onPaidOrder(
        tx as never,
        {
          id: orderId,
          userId,
          zone: PRODUCT_ZONE_STARTUP,
          goodsTotalFen,
          pvFen: 0,
        },
        stage.clock.current,
      );
    });
  }

  it('pays WeChat only, enrolls a member immediately, and keeps the button an admin decision', async () => {
    const stage = buildStage4(ratios(0, 0));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const guest = await loginBuyer(stage, 'guest', rootId);
    await expect(stage.cofounderPay.start(guest)).rejects.toBeInstanceOf(ForbiddenException);

    const member = await loginBuyer(stage, 'member', rootId);
    const productId = await startupProduct(stage, 4);
    await buyStartup(stage, member, productId, 1);
    expect(stage.db.user.rows.find((row) => row.id === member)?.member).toBe(true);

    await stage.wallet.credit({
      userId: member,
      walletType: 'points',
      amountFen: 50_000n,
      bizType: 'test_credit',
      bizId: 'points-member',
    });
    const pointsBefore = stage.db.walletAccount.rows.find(
      (row) => row.userId === member && row.walletType === 'points',
    )?.balanceFen;

    expect((await stage.cofounderEnrollment.pageFor(member)).button).toEqual({
      available: false,
      reason: 'closed',
    });
    await expect(stage.cofounderPay.start(member)).rejects.toBeInstanceOf(ConflictException);

    await stage.cofounderAdmin.updateSettings(config({ activationAmountFen: 0n }), 7n);
    expect((await stage.cofounderEnrollment.pageFor(member)).button.reason).toBe('amount_unset');

    await stage.cofounderAdmin.updateSettings(
      config({ seatCap: 1, activationAmountFen: 8_800n }),
      7n,
    );
    const started = await stage.cofounderPay.start(member);
    expect(started.mode).toBe('sandbox');
    expect(started.purpose).toBe('cofounder_activation');
    expect(started.orderId).toBeNull();
    expect(started.amountFen).toBe(8800);
    expect(stage.db.order.rows).toHaveLength(1);

    await stage.wechatPay.simulateSuccess(started.payNo);
    await stage.wechatPay.simulateSuccess(started.payNo);
    const page = await stage.cofounderEnrollment.pageFor(member);
    expect(page.enrolled).toBe(true);
    expect(page.button).toEqual({ available: false, reason: 'already_enrolled' });
    expect(page.enrolledCount).toBe(1);
    expect(stage.db.cofounderEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      1,
    );
    expect(
      stage.db.cashLedgerEntry.rows.filter(
        (row) => row.bizType === CASH_COFOUNDER_ACTIVATION && row.direction === CASH_INFLOW,
      ),
    ).toEqual([expect.objectContaining({ amountFen: 8800n, bizId: expect.any(String) })]);
    expect(
      stage.db.walletAccount.rows.find(
        (row) => row.userId === member && row.walletType === 'points',
      )?.balanceFen,
    ).toBe(pointsBefore);
    expect(stage.db.order.rows).toHaveLength(1);

    const other = await loginBuyer(stage, 'other', rootId);
    await buyStartup(stage, other, productId, 1);
    expect((await stage.cofounderEnrollment.pageFor(other)).button.reason).toBe('cap_full');
    await expect(stage.cofounderPay.start(other)).rejects.toThrow('名额已满');
    const appointed = await stage.cofounderAdmin.appoint(other, 7n);
    expect(appointed.source).toBe('appointment');
    expect((await stage.cofounderAdmin.getSettings()).enrolledCount).toBe(2);

    const user = stage.db.user.rows.find((row) => row.id === member);
    if (!user) {
      throw new Error('missing member');
    }
    user.status = 'disabled';
    await expect(stage.cofounderPay.start(member)).rejects.toBeInstanceOf(UnauthorizedException);
    user.status = 'active';
  });

  it('does not enroll or charge when live WeChat would be required', async () => {
    const stage = buildStage4(ratios(0, 0));
    const rootId = await boot(stage);
    const member = await loginBuyer(stage, 'live', rootId);
    const productId = await startupProduct(stage, 2);
    await buyStartup(stage, member, productId, 1);
    await stage.cofounderAdmin.updateSettings(config(), 7n);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const credentials: WechatPayCredentials = {
      merchantId: '1900000109',
      apiV3Key: '0123456789abcdef0123456789abcdef',
      certificatePem: 'test-certificate',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      serialNumber: 'ABC',
    };
    stage.paySettings.credentials = credentials;
    await expect(stage.cofounderPay.start(member)).rejects.toBeInstanceOf(BadRequestException);
    expect(stage.db.cofounderEnrollment.rows).toHaveLength(0);

    stage.env.wechatPayNotifyUrl = 'https://mall.example.com/api/v1/payments/wechat/notify';
    stage.gateway.createJsapiTransaction.mockResolvedValue({ prepayId: 'prepay-cofounder' });
    const started = await stage.cofounderPay.start(member);
    expect(started.mode).toBe('live');
    expect(started.paySign).toEqual(expect.any(String));
    expect(stage.db.cofounderEnrollment.rows).toHaveLength(0);
    await expect(stage.wechatPay.simulateSuccess(started.payNo)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    stage.gateway.verifyAndDecrypt.mockResolvedValue({
      outTradeNo: started.payNo,
      transactionId: 'wx-tx-1',
      tradeState: 'SUCCESS',
      mchId: '1900000109',
      amountFen: 8800,
    });
    await stage.wechatPay.handleNotify('{}', {
      timestamp: '1',
      nonce: 'n',
      signature: 's',
      serial: 'ABC',
    });
    await stage.wechatPay.handleNotify('{}', {
      timestamp: '1',
      nonce: 'n',
      signature: 's',
      serial: 'ABC',
    });
    expect(stage.db.cofounderEnrollment.rows).toHaveLength(1);
    expect(
      stage.db.cashLedgerEntry.rows.filter((row) => row.bizType === CASH_COFOUNDER_ACTIVATION),
    ).toHaveLength(1);
  });

  it('cancels without a refund and does not reopen the button by itself', async () => {
    const stage = buildStage4(ratios(200, 200));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const member = await loginBuyer(stage, 'cancel', rootId);
    const productId = await startupProduct(stage, 4, 0);
    await buyStartup(stage, member, productId, 1);
    await stage.cofounderAdmin.updateSettings(config({ activationAmountFen: 1000n }), 3n);
    const started = await stage.cofounderPay.start(member);
    await stage.wechatPay.simulateSuccess(started.payNo);
    await stage.wallet.credit({
      userId: member,
      walletType: 'withdrawable',
      amountFen: 4_000n,
      bizType: 'test_credit',
      bizId: 'withdraw-seed',
      sourceCode: null,
    });
    const appliedAt = stage.clock.current;
    const application = await stage.db.withdrawalApplication.create({
      data: {
        userId: member,
        amountFen: 3_000n,
        status: 'paid',
        accountName: '张三',
        bankName: '银行',
        accountNo: '622200',
        branchName: '支行',
        appliedAt,
        createdAt: appliedAt,
        updatedAt: appliedAt,
      },
    });
    await stage.db.withdrawalSettlement.create({
      data: {
        applicationId: application.id,
        userId: member,
        outcome: 'paid',
        amountFen: 3_000n,
        feeFen: 0n,
        payoutFen: 2_900n,
        adminId: 3n,
        settledAt: appliedAt,
        createdAt: appliedAt,
      },
    });
    await stage.db.rewardLedgerEntry.create({
      data: {
        userId: member,
        rewardType: 'startup_sales',
        amountFen: 50n,
        status: 'posted',
        bizType: 'startup_sales',
        bizId: 'seed-sales',
        orderId: null,
        layer: 1,
        occurredAt: appliedAt,
        createdAt: appliedAt,
      },
    });
    const second = await loginBuyer(stage, 'second', rootId);
    await buyStartup(stage, second, productId, 1);
    await stage.cofounderAdmin.appoint(second, 3n);
    await buyStartup(stage, member, productId, 1);

    const before = await stage.cofounderReview.review(member);
    const sales = before.awards.find((row) => row.rewardType === 'startup_sales');
    const dividend = before.awards.find((row) => row.rewardType === 'cofounder');
    expect(sales?.amountFen).toBe(50n);
    expect(before.cofounderDividendFen).toBeGreaterThan(0n);
    expect(dividend?.label).toBe('联合创始人分红');
    expect(dividend?.amountFen).toBe(before.cofounderDividendFen);
    expect(before.withdrawals.completedAmountFen).toBe(3_000n);
    expect(before.withdrawals.completedPayoutFen).toBe(2_900n);
    expect(before.withdrawals.completedAmountFen).not.toBe(before.cofounderDividendFen);
    expect(before.withdrawable.balanceFen).not.toBe(before.cofounderDividendFen);
    expect(before.awards.map((row) => row.label)).toEqual(
      expect.arrayContaining(['工作室补贴', '运营团队分红', '抢红包', '职位分红']),
    );

    const balance = before.withdrawable.balanceFen;
    const outflows = stage.db.cashLedgerEntry.rows.filter(
      (row) => row.direction === 'outflow',
    ).length;
    const refunds = stage.db.orderRefund.rows.length;
    const cancelled = await stage.cofounderAdmin.cancel(member, 3n);
    expect(cancelled.status).toBe('cancelled');
    expect(stage.db.orderRefund.rows).toHaveLength(refunds);
    expect(stage.db.cashLedgerEntry.rows.filter((row) => row.direction === 'outflow')).toHaveLength(
      outflows,
    );
    const after = await stage.cofounderReview.review(member);
    expect(after.enrolled).toBe(false);
    expect(after.withdrawable.balanceFen).toBe(balance);
    expect(after.cofounderDividendFen).toBe(before.cofounderDividendFen);
    expect((await stage.cofounderAdmin.getSettings()).userButtonOpen).toBe(false);
    const watcher = await loginBuyer(stage, 'watcher', rootId);
    const watcherRow = stage.db.user.rows.find((row) => row.id === watcher);
    if (!watcherRow) {
      throw new Error('missing watcher');
    }
    watcherRow.member = true;
    expect((await stage.cofounderEnrollment.pageFor(watcher)).button.reason).toBe('closed');
    await stage.cofounderAdmin.updateSettings(
      config({ userButtonOpen: true, activationAmountFen: 1000n, seatCap: 100 }),
      3n,
    );
    expect((await stage.cofounderEnrollment.pageFor(watcher)).button.reason).toBe('open');
    expect((await stage.cofounderEnrollment.pageFor(second)).button.reason).toBe(
      'already_enrolled',
    );
  });

  it('splits startup payable and mall PV into the withdrawal wallet, including own orders', async () => {
    const stage = buildStage4(ratios(200, 1000));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const buyer = await loginBuyer(stage, 'buyer', rootId);
    const peer = await loginBuyer(stage, 'peer', rootId);
    const startupId = await startupProduct(stage, 6, 700);
    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 10_000n,
      bizType: 'test_credit',
      bizId: 'cover-goods',
    });
    const seating = await buyStartup(stage, buyer, startupId, 1);
    const seatingOrder = stage.db.order.rows.find((row) => row.id === seating);
    expect(seatingOrder?.goodsTotalFen).toBe(10_000);
    expect(seatingOrder?.payAmountFen).toBe(10_700);
    expect(seatingOrder?.wechatFen).toBe(700);
    await buyStartup(stage, peer, startupId, 1);
    expect(cofounderCredits(stage, buyer)).toHaveLength(0);
    expect(stage.db.cofounderPayoutBatch.rows.every((row) => row.enrolledCount === 0)).toBe(true);

    await stage.cofounderAdmin.appoint(buyer, 1n);
    await stage.cofounderAdmin.appoint(peer, 1n);
    const mall = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '礼盒',
      freightFen: 0,
      priceFen: 5_000,
      pvFen: 300,
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
    const mallRow = stage.db.order.rows.find((row) => row.id === mallOrder.id);
    expect(mallRow?.pvFen).toBe(300);
    expect(mallRow?.wechatFen).toBe(5_000);
    const accrual = stage.db.cofounderAccrual.rows.find((row) => row.orderId === mallOrder.id);
    expect(accrual).toMatchObject({
      baseField: 'pv_fen',
      baseFen: 300n,
      ratioBps: 1000,
      amountFen: 30n,
    });

    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 10_000n,
      bizType: 'test_credit',
      bizId: 'cover-goods-2',
    });
    const own = await buyStartup(stage, buyer, startupId, 1);
    const ownOrder = stage.db.order.rows.find((row) => row.id === own);
    expect(ownOrder?.wechatFen).toBe(700);
    const startupAccrual = stage.db.cofounderAccrual.rows.find((row) => row.orderId === own);
    expect(startupAccrual).toMatchObject({
      baseField: 'goods_total_fen',
      baseFen: 10_000n,
      ratioBps: 200,
      amountFen: 200n,
    });
    expect(
      cofounderCredits(stage, buyer).reduce((sum, row) => sum + (row.amountFen as bigint), 0n),
    ).toBe(115n);
    expect(
      cofounderCredits(stage, peer).reduce((sum, row) => sum + (row.amountFen as bigint), 0n),
    ).toBe(115n);
    expect(
      cofounderCredits(stage, buyer).every(
        (row) => row.walletType === 'withdrawable' && row.sourceCode === 'cofounder',
      ),
    ).toBe(true);

    const categories = await stage.displayNames.categoriesForUser(buyer);
    expect(categories.categories.find((row) => row.displayName === '系统奖励')).toMatchObject({
      totalFen: 115n,
      sourceCodes: ['cofounder'],
    });
    const orderId = own;
    await stage.db.$transaction(async (tx) => {
      await stage.cofounderDividend.onPaidOrder(
        tx as never,
        {
          id: orderId,
          userId: buyer,
          zone: PRODUCT_ZONE_STARTUP,
          goodsTotalFen: 10_000,
          pvFen: 0,
        },
        stage.clock.current,
      );
    });
    expect(cofounderCredits(stage, buyer)).toHaveLength(2);
  });

  it('pays the whole pool past a threshold, including the overshoot, and flushes on a mode change', async () => {
    const stage = buildStage4(ratios(10_000, 0, 1));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const first = await loginBuyer(stage, 'pool-a', rootId);
    const second = await loginBuyer(stage, 'pool-b', rootId);
    const productId = await startupProduct(stage, 30_000);
    await buyStartup(stage, first, productId, 1);
    await buyStartup(stage, second, productId, 1);
    await stage.cofounderAdmin.appoint(first, 1n);
    await stage.cofounderAdmin.appoint(second, 1n);
    await stage.cofounderAdmin.updateSettings(
      config({ payoutMode: 'pool_total', poolThresholdFen: 20_000n, activationAmountFen: 1n }),
      1n,
    );
    expect(await stage.cofounderPool.readBalance()).toBe(0n);

    await accrueStartup(stage, first, 910_001n, 19_999);
    expect(await stage.cofounderPool.readBalance()).toBe(19_999n);
    expect(cofounderCredits(stage, first)).toHaveLength(0);
    await accrueStartup(stage, first, 910_002n, 2);
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    const batch = stage.db.cofounderPayoutBatch.rows.find((row) => row.mode === 'pool_total');
    expect(batch).toMatchObject({
      totalFen: 20_001n,
      enrolledCount: 2,
      shareFen: 10_000n,
      distributedFen: 20_000n,
      retainedFen: 1n,
    });
    expect(
      cofounderCredits(stage, first).reduce((sum, row) => sum + (row.amountFen as bigint), 0n),
    ).toBe(10_000n);
    expect(
      cofounderCredits(stage, second).reduce((sum, row) => sum + (row.amountFen as bigint), 0n),
    ).toBe(10_000n);

    await accrueStartup(stage, second, 910_003n, 501);
    expect(await stage.cofounderPool.readBalance()).toBe(501n);
    await stage.cofounderAdmin.updateSettings(
      config({ payoutMode: 'immediate', activationAmountFen: 1n }),
      1n,
    );
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    const flushed = stage.db.cofounderPayoutBatch.rows.find((row) => row.mode === 'mode_switch');
    expect(flushed).toMatchObject({
      totalFen: 501n,
      shareFen: 250n,
      retainedFen: 1n,
      distributedFen: 500n,
    });
    await accrueStartup(stage, second, 910_004n, 4);
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    expect(stage.db.cofounderAccrual.rows.find((row) => row.amountFen === 4n)).toBeTruthy();
  });

  it('pays a per-person threshold from the whole pool and keeps an empty roster with the system', async () => {
    const stage = buildStage4(ratios(10_000, 0, 1));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const only = await loginBuyer(stage, 'only', rootId);
    const productId = await startupProduct(stage, 100);
    await buyStartup(stage, only, productId, 1);
    await stage.cofounderAdmin.updateSettings(
      config({
        payoutMode: 'per_person',
        perPersonThresholdFen: 10_000n,
        activationAmountFen: 1n,
      }),
      1n,
    );
    await accrueStartup(stage, only, 920_050n, 50);
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    expect(
      stage.db.cofounderPayoutBatch.rows.some(
        (row) => row.mode === 'per_person' && row.enrolledCount === 0 && row.retainedFen === 50n,
      ),
    ).toBe(true);
    expect(cofounderCredits(stage, only)).toHaveLength(0);

    await stage.cofounderAdmin.appoint(only, 1n);
    await accrueStartup(stage, only, 920_099n, 9_999);
    expect(await stage.cofounderPool.readBalance()).toBe(9_999n);
    await accrueStartup(stage, only, 920_101n, 2);
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    expect(
      cofounderCredits(stage, only).reduce((sum, row) => sum + (row.amountFen as bigint), 0n),
    ).toBe(10_001n);

    await stage.cofounderAdmin.cancel(only, 1n);
    await stage.cofounderAdmin.updateSettings(
      config({ payoutMode: 'per_person', perPersonThresholdFen: 10_000n, userButtonOpen: false }),
      1n,
    );
    await accrueStartup(stage, only, 920_180n, 80);
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    expect(cofounderCredits(stage, only)).toHaveLength(1);
    const kept = stage.db.cofounderPayoutBatch.rows.filter((row) => row.retainedFen === 80n);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.distributedFen).toBe(0n);
  });

  it('pays a periodic pool at the configured Shanghai time and does not pay twice', async () => {
    const stage = buildStage4(ratios(10_000, 0, 100));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const member = await loginBuyer(stage, 'clock', rootId);
    const productId = await startupProduct(stage, 5);
    await buyStartup(stage, member, productId, 1);
    await stage.cofounderAdmin.appoint(member, 1n);
    await stage.cofounderAdmin.updateSettings(
      config({
        payoutMode: 'periodic',
        schedule: schedule({ cycle: 'daily', time: '00:01' }),
        activationAmountFen: 1n,
      }),
      1n,
    );
    await buyStartup(stage, member, productId, 1);
    expect(await stage.cofounderPool.readBalance()).toBe(100n);

    stage.clock.current = APR2_BEFORE;
    await stage.jobs.runDue();
    expect(await stage.cofounderPool.readBalance()).toBe(100n);
    expect(cofounderCredits(stage, member)).toHaveLength(0);

    stage.clock.current = APR2_AT;
    await stage.jobs.runDue();
    await stage.jobs.runDue();
    expect(await stage.cofounderPool.readBalance()).toBe(0n);
    expect(cofounderCredits(stage, member)).toHaveLength(1);
    expect(cofounderCredits(stage, member)[0]?.amountFen).toBe(100n);
    expect(stage.db.cofounderScheduleSlot.rows.map((row) => row.slotKey)).toEqual(
      expect.arrayContaining(['daily:2026-04-01', 'daily:2026-04-02']),
    );
  });

  it('adds activation WeChat inflow to the ops overview and not to merchandise cash', async () => {
    const stage = buildStage4(ratios(0, 0));
    const rootId = await boot(stage);
    stage.clock.current = APR1_NOON;
    const member = await loginBuyer(stage, 'cash', rootId);
    const productId = await startupProduct(stage, 2);
    await buyStartup(stage, member, productId, 1);
    const orderWechat = stage.db.order.rows.reduce((sum, row) => sum + Number(row.wechatFen), 0);
    await stage.cofounderAdmin.updateSettings(config({ activationAmountFen: 6_600n }), 1n);
    const started = await stage.cofounderPay.start(member);
    await stage.wechatPay.simulateSuccess(started.payNo);
    const ops = new OpsOverviewService(
      stage.db as never,
      stage.clock as never,
      stage.positions,
      stage.locked,
    );
    const overview = await ops.get({ period: 'today' });
    expect(overview.composition.cash.cofounderActivationFen).toBe(6_600n);
    expect(overview.composition.cash.wechatCashInFen).toBe(BigInt(orderWechat));
    expect(overview.kpis.wechatCash.cashInFen).toBe(BigInt(orderWechat));
  });

  it('rejects locked dividend rates on the settings contract', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        {
          ...config({ activationAmountFen: 1n, poolThresholdFen: 1n, perPersonThresholdFen: 1n }),
          activationAmountFen: '1',
          poolThresholdFen: '1',
          perPersonThresholdFen: '1',
          cofounderStartupDividendRatioBps: 1,
        },
        { type: 'body', metatype: UpdateCofounderSettingsDto, data: '' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sanitizes the rich-text intro body but keeps images', async () => {
    const stage = buildStage4(ratios(200, 200));
    await boot(stage);
    const saved = await stage.cofounderSettings.setContent(
      {
        entryCopy: '',
        entryImageUrls: [],
        introTitle: '联创介绍',
        introBody:
          '<p style="text-align:center">权益说明</p><script>alert(1)</script>' +
          '<img src="https://cdn.example.com/c.png" onerror="alert(2)"><iframe></iframe>',
        introImageUrls: [],
      },
      1n,
    );
    expect(saved.introBody).toContain('权益说明');
    expect(saved.introBody).toContain('<img src="https://cdn.example.com/c.png" />');
    expect(saved.introBody).not.toContain('<script');
    expect(saved.introBody).not.toContain('onerror');
    expect(saved.introBody).not.toContain('<iframe');
    // 纯文本旧内容原样保留。
    const plain = await stage.cofounderSettings.setContent(
      { entryCopy: '', entryImageUrls: [], introTitle: '', introBody: '旧版纯文本介绍', introImageUrls: [] },
      1n,
    );
    expect(plain.introBody).toBe('旧版纯文本介绍');
  });
});
