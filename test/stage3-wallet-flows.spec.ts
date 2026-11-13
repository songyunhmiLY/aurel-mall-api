import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { RefundsService } from '../src/modules/orders/refunds.service';
import {
  WechatRefundAlreadyAccepted,
  type WechatPayGateway,
} from '../src/modules/payments/wechat-pay.gateway';
import type { WechatPaySettingsService } from '../src/modules/payments/wechat-pay-settings.service';
import { BankAccountService } from '../src/modules/wallet/bank-account.service';
import { CashLedgerService } from '../src/modules/wallet/cash-ledger.service';
import { DisplayNameService } from '../src/modules/wallet/display-name.service';
import { PaymentPasswordService } from '../src/modules/wallet/payment-password.service';
import { TransferService } from '../src/modules/wallet/transfer.service';
import { WithdrawalService } from '../src/modules/wallet/withdrawal.service';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  loginBuyer,
  type Stage2,
} from './support/stage2-harness';

const KYC = {
  realName: '张三',
  idNumber: '11010119900307888X',
  mobile: '13800138000',
};

const BANK = {
  accountName: '张三',
  bankName: '中国银行',
  accountNo: '6222021234567890123',
  branchName: '杭州西湖支行',
};

function wire(stage: Stage2, fees = { withdrawalFeeFen: 100 }) {
  const prisma = stage.db as unknown as PrismaService;
  const clock = stage.clock as unknown as ClockService;
  const passwords = new PaymentPasswordService(prisma, clock);
  const banks = new BankAccountService(prisma, clock);
  const transfers = new TransferService(prisma, clock, stage.wallet, passwords);
  const cash = new CashLedgerService();
  const withdrawals = new WithdrawalService(prisma, clock, stage.wallet, stage.kyc, cash, fees);
  const names = new DisplayNameService(prisma, clock, stage.wallet);
  const refunds = new RefundsService(
    prisma,
    clock,
    stage.wallet,
    cash,
    stage.paySettings as unknown as WechatPaySettingsService,
    stage.gateway as unknown as WechatPayGateway,
  );
  return { passwords, banks, transfers, withdrawals, names, refunds, fees };
}

function makeMember(stage: Stage2, userId: bigint, nickname?: string): void {
  const row = stage.db.user.rows.find((item) => item.id === userId);
  if (!row) {
    throw new Error('missing user');
  }
  row.member = true;
  row.seated = true;
  if (nickname) {
    row.nickname = nickname;
  }
}

describe('stage 3 wallets, transfers, withdrawals, and mall refunds', () => {
  it('transfers consumption between members without KYC, and rejects the other cases', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const payer = await loginBuyer(stage, 'payer', rootId);
    const payee = await loginBuyer(stage, 'payee', rootId);
    const outsider = await loginBuyer(stage, 'outsider', rootId);
    makeMember(stage, payer);
    makeMember(stage, payee, '收款人');
    const { passwords, transfers } = wire(stage);
    await credit(stage, payer, 'consumption', 1_000);
    await credit(stage, payer, 'points', 500);
    expect(stage.db.userKyc.rows.some((row) => row.userId === payer)).toBe(false);

    await expect(transfers.lookup(outsider, payee)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(transfers.lookup(payer, outsider)).rejects.toThrow('对方不是会员');
    await expect(transfers.lookup(payer, 999_999n)).rejects.toThrow('对方不是会员');
    await expect(transfers.lookup(payer, payer)).rejects.toThrow('不能转给自己');
    expect(await transfers.lookup(payer, payee)).toMatchObject({
      payeeId: payee,
      nickname: '收款人',
    });

    await expect(
      transfers.transfer(payer, { payeeUserId: payee, amountFen: 100n, paymentPassword: '123456' }),
    ).rejects.toThrow('请先设置支付密码');
    await passwords.set(payer, '123456');
    await expect(passwords.set(payer, '654321')).rejects.toThrow('支付密码已设置');
    const before = (await stage.wallet.getBalances(payer)).consumption.balanceFen;
    await expect(
      transfers.transfer(payer, { payeeUserId: payee, amountFen: 100n, paymentPassword: '000000' }),
    ).rejects.toThrow('支付密码错误');
    expect((await stage.wallet.getBalances(payer)).consumption.balanceFen).toBe(before);
    expect(stage.db.consumptionTransfer.rows).toHaveLength(0);

    await expect(
      transfers.transfer(payer, {
        payeeUserId: payee,
        amountFen: 2_000n,
        paymentPassword: '123456',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(stage.db.consumptionTransfer.rows).toHaveLength(0);

    const moved = await transfers.transfer(payer, {
      payeeUserId: payee,
      amountFen: 400n,
      paymentPassword: '123456',
    });
    expect(moved.amountFen).toBe(400n);
    expect((await stage.wallet.getBalances(payer)).consumption).toMatchObject({
      balanceFen: 600n,
      frozenFen: 0n,
      availableFen: 600n,
    });
    expect((await stage.wallet.getBalances(payee)).consumption.balanceFen).toBe(400n);
    expect((await stage.wallet.getBalances(payer)).points.balanceFen).toBe(500n);
    const payerLedger = await stage.wallet.listLedger(payer, 'consumption', 1, 10);
    const payeeLedger = await stage.wallet.listLedger(payee, 'consumption', 1, 10);
    expect(payerLedger.items[0]).toMatchObject({
      direction: 'debit',
      amountFen: 400n,
      bizType: 'consumption_transfer',
      bizId: moved.id.toString(),
    });
    expect(payeeLedger.items[0]).toMatchObject({
      direction: 'credit',
      amountFen: 400n,
      bizId: moved.id.toString(),
    });
    expect(stage.db.userKyc.rows.some((row) => row.userId === payer)).toBe(false);
  });

  it('freezes a member withdrawal, unfreezes on reject, and uses the fee at payout', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const userId = await loginBuyer(stage, 'withdrawer', rootId);
    const stranger = await loginBuyer(stage, 'stranger', rootId);
    const fees = { withdrawalFeeFen: 100 };
    const { banks, withdrawals } = wire(stage, fees);
    await credit(stage, userId, 'withdrawable', 30_000);
    await credit(stage, stranger, 'withdrawable', 30_000);
    await banks.save(userId, BANK);

    await expect(withdrawals.apply(stranger, 10_000n)).rejects.toThrow('非会员不能提现');
    makeMember(stage, userId);
    await expect(withdrawals.apply(userId, 9_999n)).rejects.toThrow('提现金额不能低于 100 元');
    await expect(withdrawals.apply(userId, 10_000n)).rejects.toThrow('请先完成实名认证');
    expect((await stage.wallet.getBalances(userId)).withdrawable.frozenFen).toBe(0n);

    await stage.kyc.submit(userId, KYC);
    const applied = await withdrawals.apply(userId, 10_000n);
    expect(applied.status).toBe('pending');
    expect(applied.accountName).toBe('张三');
    expect(applied.settlement).toBeNull();
    expect((await stage.wallet.getBalances(userId)).withdrawable).toMatchObject({
      balanceFen: 30_000n,
      frozenFen: 10_000n,
      availableFen: 20_000n,
    });
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.userId === userId && row.bizType === 'withdrawal_payout',
      ),
    ).toHaveLength(0);

    await banks.save(userId, { ...BANK, accountNo: '6222020000000000001' });
    const rejected = await withdrawals.reject(applied.id, 7n);
    expect(rejected.status).toBe('rejected');
    expect(rejected.accountNo).toBe('6222021234567890123');
    expect(rejected.settlement).toMatchObject({
      outcome: 'rejected',
      feeFen: null,
      payoutFen: null,
    });
    expect((await stage.wallet.getBalances(userId)).withdrawable).toMatchObject({
      balanceFen: 30_000n,
      frozenFen: 0n,
    });

    const again = await withdrawals.apply(userId, 10_000n);
    fees.withdrawalFeeFen = 300;
    const paid = await withdrawals.payout(again.id, 7n);
    expect(paid.status).toBe('paid');
    expect(paid.settlement).toMatchObject({ outcome: 'paid', feeFen: 300n, payoutFen: 9_700n });
    expect((await stage.wallet.getBalances(userId)).withdrawable).toMatchObject({
      balanceFen: 20_000n,
      frozenFen: 0n,
    });
    expect(stage.db.cashLedgerEntry.rows).toEqual([
      expect.objectContaining({
        direction: 'outflow',
        amountFen: 9_700n,
        bizType: 'withdrawal_payout',
        bizId: again.id.toString(),
      }),
    ]);
    await expect(withdrawals.payout(again.id, 7n)).rejects.toThrow('提现申请已处理');

    fees.withdrawalFeeFen = 20_000;
    const blocked = await withdrawals.apply(userId, 10_000n);
    await expect(withdrawals.payout(blocked.id, 7n)).rejects.toThrow('当前手续费高于提现金额');
    expect((await stage.wallet.getBalances(userId)).withdrawable.frozenFen).toBe(10_000n);
    expect(blocked.status).toBe('pending');
  });

  it('groups withdrawal display categories by the configured name', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const userId = await loginBuyer(stage, 'ledger', rootId);
    makeMember(stage, userId);
    const { names } = wire(stage);
    await expect(
      stage.wallet.credit({
        userId,
        walletType: 'points',
        amountFen: 10n,
        bizType: 'reward',
        bizId: 'nope',
        sourceCode: 'startup_sales',
      }),
    ).rejects.toThrow('提现分类来源不正确');
    await expect(
      stage.wallet.credit({
        userId,
        walletType: 'withdrawable',
        amountFen: 10n,
        bizType: 'reward',
        bizId: 'extra',
        sourceCode: 'not_a_source',
      }),
    ).rejects.toThrow('提现分类来源不正确');

    await stage.wallet.credit({
      userId,
      walletType: 'withdrawable',
      amountFen: 1_000n,
      bizType: 'reward',
      bizId: 'a',
      sourceCode: 'startup_sales',
    });
    await stage.wallet.credit({
      userId,
      walletType: 'withdrawable',
      amountFen: 2_500n,
      bizType: 'reward',
      bizId: 'b',
      sourceCode: 'mall_sales',
    });
    await stage.wallet.credit({
      userId,
      walletType: 'withdrawable',
      amountFen: 400n,
      bizType: 'reward',
      bizId: 'filing',
      sourceCode: 'filing_settlement',
    });
    await stage.wallet.credit({
      userId,
      walletType: 'withdrawable',
      amountFen: 600n,
      bizType: 'reward',
      bizId: 'position',
      sourceCode: 'position_dividend',
    });
    const fresh = await names.categoriesForUser(userId);
    expect(fresh.balanceFen).toBe(4_500n);
    expect(fresh.categories).toHaveLength(7);
    const byName = new Map(fresh.categories.map((item) => [item.displayName, item]));
    expect([...byName.keys()].sort()).toEqual(
      ['业绩奖', '幸运返还', '平台分红', '系统奖励', '系统激励', '系统红包', '销售激励'].sort(),
    );
    expect(byName.get('销售激励')).toMatchObject({
      totalFen: 3_500n,
      sourceCodes: ['mall_points', 'mall_sales', 'startup_points', 'startup_sales'],
    });
    expect(byName.get('幸运返还')?.sourceCodes).toEqual(['filing_settlement']);
    expect(byName.get('幸运返还')?.totalFen).toBe(400n);
    expect(byName.get('业绩奖')).toMatchObject({
      totalFen: 600n,
      sourceCodes: ['position_dividend'],
    });
    expect(byName.get('系统奖励')?.sourceCodes).toEqual(['cofounder']);
    expect(byName.get('系统激励')?.sourceCodes).toEqual(['studio']);
    expect(byName.get('平台分红')?.sourceCodes).toEqual(['operations']);
    expect(byName.get('系统红包')?.sourceCodes).toEqual(['red_packet']);
    const listed = await names.listSources();
    expect(listed.items.find((item) => item.sourceCode === 'filing_settlement')?.displayName).toBe(
      '幸运返还',
    );

    await names.updateSources(
      [
        { sourceCode: 'filing_settlement', displayName: '合并奖' },
        { sourceCode: 'position_dividend', displayName: '合并奖' },
      ],
      3n,
    );
    const grouped = await names.categoriesForUser(userId);
    expect(grouped.categories).toHaveLength(6);
    const merged = grouped.categories.find((item) => item.displayName === '合并奖');
    expect(merged).toMatchObject({
      totalFen: 1_000n,
      sourceCodes: ['filing_settlement', 'position_dividend'],
    });
    expect(grouped.categories.find((item) => item.displayName === '销售激励')?.totalFen).toBe(
      3_500n,
    );
    const ledger = await names.categoryLedger(userId, '销售激励', 1, 10);
    expect(ledger.total).toBe(2);
    expect(
      ledger.items.map((item) => item.amountFen).sort((left, right) => (left < right ? -1 : 1)),
    ).toEqual([1_000n, 2_500n]);
    await expect(names.categoryLedger(userId, '不存在的分类', 1, 10)).rejects.toThrow('分类不存在');
  });

  it('refunds a paid mall order without rolling rewards back, and keeps stage-2 payment', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'mall-buyer', rootId);
    makeMember(stage, buyer);
    const { refunds } = wire(stage);
    expect(stage.db.userKyc.rows.some((row) => row.userId === buyer)).toBe(false);
    const addressId = await addressOf(stage, buyer);
    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '商城商品',
      freightFen: 500,
      priceFen: 9_500,
      pvFen: 100,
      stockQuantity: 4,
      status: 'on',
    });
    const startup = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen: 0,
      stockQuantity: 2,
      status: 'on',
    });
    await credit(stage, buyer, 'consumption', 4_000);
    await credit(stage, buyer, 'withdrawable', 3_000);
    const startupOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: startup.product.id, quantity: 1 }],
    });
    await expect(refunds.apply(buyer, startupOrder.id)).rejects.toThrow('创业专区订单不能退款');

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: product.product.id, quantity: 1 }],
    });
    const started = await stage.orders.pay(buyer, created.id);
    expect(started.order).toMatchObject({
      consumptionFen: 4_000,
      withdrawableFen: 3_000,
      wechatFen: 3_000,
      pointsFen: 0,
      payAmountFen: 10_000,
      freightFen: 500,
    });
    const payNo = started.wechat?.payNo;
    if (!payNo) {
      throw new Error('missing pay no');
    }
    await stage.wechatPay.simulateSuccess(payNo);
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('paid');
    await credit(stage, buyer, 'withdrawable', 5_000);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(5_000n);

    const reward = stage.db.rewardLedgerEntry.create({
      data: {
        userId: buyer,
        rewardType: 'mall_sales',
        amountFen: 1_234n,
        status: 'posted',
        bizType: 'order',
        bizId: created.id.toString(),
        occurredAt: stage.clock.current,
        createdAt: stage.clock.current,
      },
    });
    const applied = await refunds.apply(buyer, created.id);
    expect(applied.status).toBe('pending');
    expect(applied.deductionFen).toBeNull();
    expect(applied.refundFen).toBeNull();
    expect(applied.freightFen).toBe(500);
    expect(applied.deductionHint).toContain('不会自动计入减扣');

    const approved = await refunds.approve(applied.id, 9n, { deductionFen: 1_000 });
    expect(approved).toMatchObject({
      status: 'approved',
      refundFen: 9_000,
      deductionFen: 1_000,
      wechatRefundFen: 2_000,
      withdrawableDeductionFen: 0,
      consumptionCreditFen: 7_000,
      wechatRefundStatus: 'sandbox',
    });
    expect((approved.wechatRefundFen ?? 0) + (approved.consumptionCreditFen ?? 0)).toBe(
      approved.refundFen,
    );
    expect((await stage.wallet.getBalances(buyer)).consumption.balanceFen).toBe(7_000n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.balanceFen).toBe(5_000n);
    expect((await stage.orders.getForUser(buyer, created.id)).status).toBe('paid');
    expect(stage.db.rewardLedgerEntry.rows).toEqual([reward]);
    expect(stage.db.cashLedgerEntry.rows).toEqual([
      expect.objectContaining({
        bizType: 'wechat_refund',
        amountFen: 2_000n,
        bizId: applied.id.toString(),
      }),
    ]);
    await expect(refunds.approve(applied.id, 9n, { refundFen: 1 })).rejects.toThrow(
      '退款申请已处理',
    );
    await expect(refunds.apply(buyer, created.id)).rejects.toThrow('订单已有退款申请');
  });

  it('blocks withdrawal and mall refund in both directions until the other is settled', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'mutex', rootId);
    makeMember(stage, buyer);
    const fees = { withdrawalFeeFen: 0 };
    const { banks, withdrawals, refunds } = wire(stage, fees);
    await stage.kyc.submit(buyer, KYC);
    await banks.save(buyer, BANK);
    await credit(stage, buyer, 'withdrawable', 50_000);
    await credit(stage, buyer, 'consumption', 20_000);
    const addressId = await addressOf(stage, buyer);
    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '互斥商品',
      freightFen: 0,
      priceFen: 1_000,
      pvFen: 10,
      stockQuantity: 5,
      status: 'on',
    });
    const first = await paidMall(stage, buyer, addressId, product.product.id);
    const second = await paidMall(stage, buyer, addressId, product.product.id);

    const refund = await refunds.apply(buyer, first.id);
    await expect(withdrawals.apply(buyer, 10_000n)).rejects.toThrow('有未结算的商城退款，不能提现');
    await refunds.reject(refund.id, 4n);
    const withdrawal = await withdrawals.apply(buyer, 10_000n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.frozenFen).toBe(10_000n);
    await expect(refunds.apply(buyer, second.id)).rejects.toThrow('有未完成的提现，不能申请退款');
    await withdrawals.reject(withdrawal.id, 4n);
    const retry = await refunds.apply(buyer, second.id);
    expect(retry.status).toBe('pending');
    await refunds.reject(retry.id, 4n);

    const open = await withdrawals.apply(buyer, 10_000n);
    await withdrawals.payout(open.id, 4n);
    expect((await stage.wallet.getBalances(buyer)).withdrawable.frozenFen).toBe(0n);
    const afterPayout = await refunds.apply(buyer, second.id);
    expect(afterPayout.status).toBe('pending');
    await refunds.approve(afterPayout.id, 4n, { refundFen: 1_000 });
    const afterRefund = await withdrawals.apply(buyer, 10_000n);
    expect(afterRefund.status).toBe('pending');
  });

  it('asks WeChat for the refund when merchant credentials exist, and leaves the refund pending if that fails', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'live-refund', rootId);
    makeMember(stage, buyer);
    const { refunds } = wire(stage);
    const addressId = await addressOf(stage, buyer);
    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '全额微信',
      freightFen: 0,
      priceFen: 2_000,
      pvFen: 10,
      stockQuantity: 2,
      status: 'on',
    });
    const order = await paidMall(stage, buyer, addressId, product.product.id);
    expect(order.wechatFen).toBe(2_000);
    const applied = await refunds.apply(buyer, order.id);
    stage.gateway.createDomesticRefund.mockRejectedValueOnce(new Error('down'));
    stage.paySettings.credentials = {
      merchantId: 'mch',
      apiV3Key: 'k'.repeat(32),
      certificatePem: 'cert',
      privateKeyPem: 'key',
      serialNumber: 'serial',
    };
    await expect(refunds.approve(applied.id, 1n, { refundFen: 2_000 })).rejects.toThrow('down');
    expect((await refunds.getForUser(buyer, applied.id)).status).toBe('pending');
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(0);

    stage.gateway.createDomesticRefund.mockResolvedValueOnce({
      refundId: 'wx-refund',
      status: 'PROCESSING',
    });
    const approved = await refunds.approve(applied.id, 1n, { refundFen: 2_000 });
    expect(approved.wechatRefundStatus).toBe('accepted');
    expect(approved.wechatRefundFen).toBe(2_000);
    expect(approved.consumptionCreditFen).toBe(0);
    expect(stage.gateway.createDomesticRefund).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refundFen: 2_000,
        totalFen: 2_000,
        outRefundNo: `RF${applied.id.toString()}`,
      }),
    );
    expect(stage.gateway.createDomesticRefund).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ outRefundNo: `RF${applied.id.toString()}` }),
    );
    expect(stage.db.cashLedgerEntry.rows[0]).toMatchObject({
      amountFen: 2_000n,
      bizType: 'wechat_refund',
    });
  });

  it('finishes a local refund after WeChat already accepted it, without a second refund', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'retry-refund', rootId);
    makeMember(stage, buyer);
    const { refunds } = wire(stage);
    const addressId = await addressOf(stage, buyer);
    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '重试退款',
      freightFen: 0,
      priceFen: 2_000,
      pvFen: 10,
      stockQuantity: 2,
      status: 'on',
    });
    const order = await paidMall(stage, buyer, addressId, product.product.id);
    const secondOrder = await paidMall(stage, buyer, addressId, product.product.id);
    const applied = await refunds.apply(buyer, order.id);
    stage.paySettings.credentials = {
      merchantId: 'mch',
      apiV3Key: 'k'.repeat(32),
      certificatePem: 'cert',
      privateKeyPem: 'key',
      serialNumber: 'serial',
    };
    const table = stage.db.orderRefund;
    const original = table.update.bind(table);
    let failedLocalCommit = false;
    table.update = (args) => {
      const data = args.data as { status?: string };
      if (!failedLocalCommit && data.status === 'approved') {
        failedLocalCommit = true;
        throw new Error('local commit failed');
      }
      return original(args);
    };
    stage.gateway.createDomesticRefund.mockResolvedValue({
      refundId: 'wx-refund',
      status: 'PROCESSING',
    });
    await expect(refunds.approve(applied.id, 1n, { refundFen: 2_000 })).rejects.toThrow(
      'local commit failed',
    );
    expect(stage.gateway.createDomesticRefund).toHaveBeenCalledTimes(1);
    expect(stage.db.orderRefund.rows[0]).toMatchObject({
      status: 'pending',
      wechatRefundStatus: 'accepted',
      wechatRefundNo: `RF${applied.id.toString()}`,
      wechatRefundFen: 2_000,
    });
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(0);

    const approved = await refunds.approve(applied.id, 1n, { refundFen: 2_000 });
    expect(stage.gateway.createDomesticRefund).toHaveBeenCalledTimes(1);
    expect(approved).toMatchObject({
      status: 'approved',
      wechatRefundStatus: 'accepted',
      wechatRefundFen: 2_000,
    });
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(1);

    const again = await refunds.apply(buyer, secondOrder.id);
    stage.gateway.createDomesticRefund.mockRejectedValueOnce(new WechatRefundAlreadyAccepted());
    const reconciled = await refunds.approve(again.id, 1n, { refundFen: 2_000 });
    expect(reconciled).toMatchObject({
      status: 'approved',
      wechatRefundStatus: 'accepted',
      wechatRefundFen: 2_000,
    });
    expect(stage.gateway.createDomesticRefund).toHaveBeenCalledTimes(2);
    expect(stage.gateway.createDomesticRefund).toHaveBeenLastCalledWith(
      expect.objectContaining({ outRefundNo: `RF${again.id.toString()}` }),
    );
  });

  it('does not create a pending withdrawal and a pending mall refund together', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'mutex-race', rootId);
    makeMember(stage, buyer);
    const { banks, withdrawals, refunds } = wire(stage, { withdrawalFeeFen: 0 });
    await stage.kyc.submit(buyer, KYC);
    await banks.save(buyer, BANK);
    await credit(stage, buyer, 'withdrawable', 50_000);
    const addressId = await addressOf(stage, buyer);
    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '并发互斥',
      freightFen: 0,
      priceFen: 1_000,
      pvFen: 10,
      stockQuantity: 2,
      status: 'on',
    });
    const order = await paidMall(stage, buyer, addressId, product.product.id);
    const results = await Promise.allSettled([
      withdrawals.apply(buyer, 10_000n),
      refunds.apply(buyer, order.id),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : null;
    const message = reason instanceof Error ? reason.message : '';
    expect(
      message === '有未结算的商城退款，不能提现' || message === '有未完成的提现，不能申请退款',
    ).toBe(true);
    const pendingWithdrawals = stage.db.withdrawalApplication.rows.filter(
      (row) => row.status === 'pending',
    );
    const pendingRefunds = stage.db.orderRefund.rows.filter((row) => row.status === 'pending');
    expect(pendingWithdrawals.length + pendingRefunds.length).toBe(1);
  });
});

async function paidMall(stage: Stage2, userId: bigint, addressId: bigint, productId: bigint) {
  const created = await stage.orders.create(userId, {
    zone: PRODUCT_ZONE_MALL,
    addressId,
    items: [{ productId, quantity: 1 }],
  });
  const started = await stage.orders.pay(userId, created.id);
  if (started.wechat) {
    await stage.wechatPay.simulateSuccess(started.wechat.payNo);
  }
  return stage.orders.getForUser(userId, created.id);
}
