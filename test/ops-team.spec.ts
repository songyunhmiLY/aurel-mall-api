import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import type { LockedRuntimeConfig } from '../src/config/locked-runtime';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { UpdateCofounderContentDto } from '../src/modules/cofounder/dto/update-cofounder-content.dto';
import { UpdateCofounderSettingsDto } from '../src/modules/cofounder/dto/update-cofounder-settings.dto';
import { OpsOverviewService } from '../src/modules/ops/ops-overview.service';
import { UpdateWechatPaySettingsDto } from '../src/modules/payments/dto/update-wechat-pay-settings.dto';
import { UpdatePayoutDateDto } from '../src/modules/rewards/positions/dto/update-payout-date.dto';
import { UpdateWelfareEntryDto } from '../src/modules/rewards/red-packet/dto/update-welfare-entry.dto';
import { UpdateMarketThresholdDto } from '../src/modules/settings/dto/update-market-threshold.dto';
import { UpdateStudioSettingsDto } from '../src/modules/studio/dto/update-studio-settings.dto';
import { UpdateDisplayNamesDto } from '../src/modules/wallet/dto/update-display-names.dto';
import { buildStage4, stage4Locked, type Stage4 } from './support/stage4-harness';

function opsLocked(
  startupBps: number,
  mallBps: number,
  studioStartup = 0,
  studioMall = 0,
  cofounderStartup = 0,
  cofounderMall = 0,
): LockedRuntimeConfig {
  return Object.freeze({
    ...stage4Locked(10_000),
    startupSalesRatioBps: 0,
    startupPointRatioBps: 0,
    mallSalesRatioBps: 0,
    mallPointRatioBps: 0,
    filingWithdrawalRatioBps: 0,
    redPacketDailyAccrualBps: 0,
    cofounderDividendRatioBps: cofounderStartup,
    cofounderStartupDividendRatioBps: cofounderStartup,
    cofounderMallDividendRatioBps: cofounderMall,
    studioStartupSubsidyRatioBps: studioStartup,
    studioMallSubsidyRatioBps: studioMall,
    opsTeamStartupDividendRatioBps: startupBps,
    opsTeamMallDividendRatioBps: mallBps,
  });
}

describe('ops team dividend', () => {
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

  async function startupProduct(stage: Stage4, stock: number, freightFen = 0): Promise<bigint> {
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

  function opsCredits(stage: Stage4, userId: bigint) {
    return stage.db.walletLedgerEntry.rows.filter(
      (row) =>
        row.userId === userId &&
        typeof row.bizType === 'string' &&
        row.bizType.startsWith('operations_') &&
        row.direction === 'credit',
    );
  }

  function opsSum(stage: Stage4, userId: bigint): bigint {
    return opsCredits(stage, userId).reduce((sum, row) => sum + (row.amountFen as bigint), 0n);
  }

  it('allows one member holder, reassigns immediately, and does not clear other identities', async () => {
    const stage = buildStage4(opsLocked(500, 700));
    const rootId = await boot(stage);
    expect(await stage.opsTeamEnrollment.current()).toEqual({ holder: null });

    const guest = await loginBuyer(stage, 'guest', rootId);
    await expect(stage.opsTeamEnrollment.appoint(guest, 1n)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(stage.opsTeamEnrollment.appoint(999_999n, 1n)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(stage.db.opsTeamEnrollment.rows).toHaveLength(0);
    expect(await stage.opsTeamEnrollment.current()).toEqual({ holder: null });

    const productId = await startupProduct(stage, 8);
    const first = await loginBuyer(stage, 'first', rootId);
    const second = await loginBuyer(stage, 'second', rootId);
    await buyStartup(stage, first, productId, 1);
    await buyStartup(stage, second, productId, 1);
    expect(stage.db.opsTeamAccrual.rows).toHaveLength(0);

    await stage.cofounderAdmin.appoint(first, 3n);
    await stage.studioEnrollment.appoint(first, 3n);
    const appointed = await stage.opsTeamEnrollment.appoint(first, 7n);
    expect(appointed).toMatchObject({
      userId: first,
      member: true,
      status: 'active',
      cancelledAt: null,
    });
    expect((await stage.opsTeamEnrollment.current()).holder?.userId).toBe(first);
    await expect(stage.opsTeamEnrollment.appoint(first, 7n)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(stage.db.opsTeamEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      1,
    );

    await expect(stage.opsTeamEnrollment.appoint(guest, 7n)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect((await stage.opsTeamEnrollment.current()).holder?.userId).toBe(first);

    const again = await stage.users.loginWithMiniProgram('first');
    expect(Object.keys(again.user).sort()).toEqual(
      ['avatarUrl', 'id', 'inviteCode', 'member', 'nickname', 'phone', 'status'].sort(),
    );

    const replaced = await stage.opsTeamEnrollment.appoint(second, 8n);
    expect(replaced.userId).toBe(second);
    expect(replaced.status).toBe('active');
    expect(stage.db.opsTeamEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      1,
    );
    expect(stage.db.opsTeamEnrollment.rows.filter((row) => row.activeSlot === 1)).toHaveLength(1);
    const previous = stage.db.opsTeamEnrollment.rows.find((row) => row.userId === first);
    expect(previous).toMatchObject({ status: 'cancelled', activeSlot: null });
    expect(previous?.cancelledAt).toBeInstanceOf(Date);
    expect(
      stage.db.cofounderEnrollment.rows.filter(
        (row) => row.userId === first && row.status === 'active',
      ),
    ).toHaveLength(1);
    expect(
      stage.db.studioEnrollment.rows.filter(
        (row) => row.userId === first && row.status === 'active',
      ),
    ).toHaveLength(1);
    expect(
      stage.db.walletLedgerEntry.rows.filter((row) => row.bizType === 'operations_startup'),
    ).toHaveLength(0);

    await stage.wallet.credit({
      userId: second,
      walletType: 'points',
      amountFen: 10_000n,
      bizType: 'test_credit',
      bizId: 'cover-reassign',
    });
    const whileSecond = await buyStartup(stage, second, productId, 1);
    expect(opsCredits(stage, second).filter((row) => row.bizId === whileSecond.toString())).toEqual(
      [
        expect.objectContaining({
          amountFen: 500n,
          sourceCode: 'operations',
          bizType: 'operations_startup',
        }),
      ],
    );
    expect(
      opsCredits(stage, first).filter((row) => row.bizId === whileSecond.toString()),
    ).toHaveLength(0);

    const kept = opsSum(stage, second);
    const balance = stage.db.walletAccount.rows.find(
      (row) => row.userId === second && row.walletType === 'withdrawable',
    )?.balanceFen;
    const cancelled = await stage.opsTeamEnrollment.cancel(9n);
    expect(cancelled).toMatchObject({ userId: second, status: 'cancelled' });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(await stage.opsTeamEnrollment.current()).toEqual({ holder: null });
    expect(opsSum(stage, second)).toBe(kept);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) =>
          row.userId === second && row.direction === 'debit' && row.bizType !== 'order_payment',
      ),
    ).toHaveLength(0);
    expect(
      stage.db.walletAccount.rows.find(
        (row) => row.userId === second && row.walletType === 'withdrawable',
      )?.balanceFen,
    ).toBe(balance);
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(0);
    await expect(stage.opsTeamEnrollment.cancel(9n)).rejects.toBeInstanceOf(NotFoundException);

    const afterCancel = await buyStartup(stage, second, productId, 1);
    expect(
      opsCredits(stage, second).filter((row) => row.bizId === afterCancel.toString()),
    ).toHaveLength(0);
    expect(opsCredits(stage, first)).toHaveLength(0);
    expect(opsSum(stage, second)).toBe(kept);
    expect(
      stage.db.cofounderEnrollment.rows.filter(
        (row) => row.userId === first && row.status === 'active',
      ),
    ).toHaveLength(1);
    expect(
      stage.db.studioEnrollment.rows.filter(
        (row) => row.userId === first && row.status === 'active',
      ),
    ).toHaveLength(1);
  });

  it('credits the one holder on every startup and mall order, with separate details', async () => {
    const stage = buildStage4(opsLocked(500, 700));
    const rootId = await boot(stage);
    const productId = await startupProduct(stage, 20, 700);
    const seated: bigint[] = [];
    for (const subject of ['a', 'b', 'c']) {
      const userId = await loginBuyer(stage, subject, rootId);
      await buyStartup(stage, userId, productId, 1);
      seated.push(userId);
    }
    const buyer = await loginBuyer(stage, 'buyer', rootId);
    await buyStartup(stage, buyer, productId, 1);
    expect(stage.db.opsTeamAccrual.rows).toHaveLength(0);

    const market = stage.db.marketTreeNode.rows.find((row) => row.userId === buyer);
    const invite = stage.db.inviteTreeNode.rows.find((row) => row.userId === buyer);
    const marketParent = market?.parentUserId;
    if (typeof marketParent !== 'bigint' || !invite) {
      throw new Error('missing tree');
    }
    expect(invite.parentUserId).toBe(rootId);
    const outsiders = seated.filter((userId) => userId !== marketParent);
    const holder = outsiders[0];
    if (holder === undefined) {
      throw new Error('missing outsider');
    }
    expect(holder).not.toBe(marketParent);
    expect(holder).not.toBe(rootId);
    await stage.opsTeamEnrollment.appoint(holder, 1n);

    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 20_000n,
      bizType: 'test_credit',
      bizId: 'cover-goods',
    });
    const startupId = await buyStartup(stage, buyer, productId, 2);
    const startup = stage.db.order.rows.find((row) => row.id === startupId);
    expect(startup).toMatchObject({ goodsTotalFen: 20_000, freightFen: 1_400 });
    expect(startup?.wechatFen).not.toBe(startup?.goodsTotalFen);
    expect(startup?.payAmountFen).not.toBe(startup?.goodsTotalFen);
    const startupAccrual = stage.db.opsTeamAccrual.rows.filter((row) => row.orderId === startupId);
    expect(startupAccrual).toEqual([
      expect.objectContaining({
        userId: holder,
        zone: PRODUCT_ZONE_STARTUP,
        baseField: 'goods_total_fen',
        baseFen: 20_000n,
        ratioBps: 500,
        amountFen: 1_000n,
      }),
    ]);
    expect(opsCredits(stage, holder).filter((row) => row.bizId === startupId.toString())).toEqual([
      expect.objectContaining({
        amountFen: 1_000n,
        walletType: 'withdrawable',
        sourceCode: 'operations',
        bizType: 'operations_startup',
      }),
    ]);
    expect(opsCredits(stage, marketParent)).toHaveLength(0);
    expect(opsCredits(stage, rootId)).toHaveLength(0);
    expect(opsCredits(stage, buyer)).toHaveLength(0);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) =>
          typeof row.bizType === 'string' &&
          row.bizType.startsWith('operations_') &&
          row.walletType !== 'withdrawable',
      ),
    ).toHaveLength(0);

    const addressId = stage.db.userAddress.rows.find((row) => row.userId === buyer)?.id;
    if (addressId === undefined) {
      throw new Error('missing address');
    }
    const mall = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '礼盒',
      freightFen: 0,
      priceFen: 8_000,
      pvFen: 10_000,
      stockQuantity: 4,
      status: 'on',
    });
    const mallOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: mall.product.id, quantity: 1 }],
    });
    await pay(stage, buyer, mallOrder.id);
    expect(stage.db.order.rows.find((row) => row.id === mallOrder.id)?.pvFen).toBe(10_000);
    expect(stage.db.opsTeamAccrual.rows.filter((row) => row.orderId === mallOrder.id)).toEqual([
      expect.objectContaining({
        userId: holder,
        zone: PRODUCT_ZONE_MALL,
        baseField: 'pv_fen',
        baseFen: 10_000n,
        ratioBps: 700,
        amountFen: 700n,
      }),
    ]);
    expect(
      opsCredits(stage, holder)
        .map((row) => row.bizType)
        .sort(),
    ).toEqual(['operations_mall', 'operations_startup']);

    const dust = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '零头',
      freightFen: 0,
      priceFen: 100,
      pvFen: 1,
      stockQuantity: 1,
      status: 'on',
    });
    const zeroOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: dust.product.id, quantity: 1 }],
    });
    await pay(stage, buyer, zeroOrder.id);
    expect(stage.db.opsTeamAccrual.rows.filter((row) => row.orderId === zeroOrder.id)).toHaveLength(
      0,
    );

    const odd = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '取整',
      freightFen: 0,
      priceFen: 20_000,
      pvFen: 10_001,
      stockQuantity: 1,
      status: 'on',
    });
    const oddOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_MALL,
      addressId,
      items: [{ productId: odd.product.id, quantity: 1 }],
    });
    await pay(stage, buyer, oddOrder.id);
    expect(stage.db.opsTeamAccrual.rows.find((row) => row.orderId === oddOrder.id)).toMatchObject({
      baseFen: 10_001n,
      ratioBps: 700,
      amountFen: 700n,
    });

    const categories = await stage.displayNames.categoriesForUser(holder);
    expect(categories.categories.find((row) => row.displayName === '平台分红')).toMatchObject({
      totalFen: 1_000n + 700n + 700n,
      sourceCodes: ['operations'],
    });
    const ledger = await stage.displayNames.categoryLedger(holder, '平台分红', 1, 10);
    expect(ledger.items.map((row) => row.bizType).sort()).toEqual([
      'operations_mall',
      'operations_mall',
      'operations_startup',
    ]);
    expect(ledger.items.every((row) => row.sourceCode === 'operations')).toBe(true);
    expect(
      stage.db.rewardLedgerEntry.rows.filter((row) => row.rewardType === 'operations'),
    ).toHaveLength(stage.db.opsTeamAccrual.rows.length);
    expect(
      stage.db.cashLedgerEntry.rows.filter(
        (row) => typeof row.bizType === 'string' && row.bizType.startsWith('operations'),
      ),
    ).toHaveLength(0);

    await stage.db.$transaction(async (tx) => {
      await stage.opsTeamDividend.onPaidOrder(
        tx as never,
        {
          id: startupId,
          userId: buyer,
          zone: PRODUCT_ZONE_STARTUP,
          goodsTotalFen: 20_000,
          pvFen: 0,
        },
        stage.clock.current,
      );
    });
    expect(
      opsCredits(stage, holder).filter((row) => row.bizId === startupId.toString()),
    ).toHaveLength(1);

    const kept = opsSum(stage, holder);
    const balance = stage.db.walletAccount.rows.find(
      (row) => row.userId === holder && row.walletType === 'withdrawable',
    )?.balanceFen;
    await stage.opsTeamEnrollment.cancel(4n);
    const later = await buyStartup(stage, buyer, productId, 1);
    expect(opsCredits(stage, holder).filter((row) => row.bizId === later.toString())).toHaveLength(
      0,
    );
    expect(opsSum(stage, holder)).toBe(kept);
    expect(
      stage.db.walletAccount.rows.find(
        (row) => row.userId === holder && row.walletType === 'withdrawable',
      )?.balanceFen,
    ).toBe(balance);
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(0);
  });

  it('still pays cofounder and studio on the same order and adds no overview card', async () => {
    const stage = buildStage4(opsLocked(500, 700, 200, 200, 200, 200));
    const rootId = await boot(stage);
    const productId = await startupProduct(stage, 8, 0);
    const buyer = await loginBuyer(stage, 'buyer', rootId);
    const peer = await loginBuyer(stage, 'peer', rootId);
    const holder = await loginBuyer(stage, 'holder', rootId);
    await buyStartup(stage, buyer, productId, 1);
    await buyStartup(stage, peer, productId, 1);
    await buyStartup(stage, holder, productId, 1);
    await stage.cofounderAdmin.appoint(buyer, 1n);
    await stage.cofounderAdmin.appoint(peer, 1n);
    await stage.studioEnrollment.appoint(rootId, 1n);
    await stage.studioEnrollment.appoint(buyer, 1n);
    await stage.opsTeamEnrollment.appoint(holder, 1n);
    expect(stage.db.cofounderEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      2,
    );
    expect(stage.db.studioEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(2);
    expect(stage.db.opsTeamEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      1,
    );

    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 10_000n,
      bizType: 'test_credit',
      bizId: 'cover',
    });
    const orderId = await buyStartup(stage, buyer, productId, 1);
    const order = stage.db.order.rows.find((row) => row.id === orderId);
    expect(order).toMatchObject({ goodsTotalFen: 10_000, wechatFen: 0, pvFen: 0 });

    expect(opsCredits(stage, holder).filter((row) => row.bizId === orderId.toString())).toEqual([
      expect.objectContaining({
        amountFen: 500n,
        walletType: 'withdrawable',
        sourceCode: 'operations',
        bizType: 'operations_startup',
      }),
    ]);
    expect(opsCredits(stage, buyer)).toHaveLength(0);
    expect(opsCredits(stage, peer)).toHaveLength(0);
    expect(opsCredits(stage, rootId)).toHaveLength(0);

    const studioOf = (userId: bigint) =>
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.userId === userId && row.bizType === 'studio' && row.direction === 'credit',
      );
    const cofounderOf = (userId: bigint) =>
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.userId === userId && row.bizType === 'cofounder' && row.direction === 'credit',
      );
    const onOrder = (rows: Array<Record<string, unknown>>) =>
      rows.filter((row) => row.bizId === orderId.toString());
    expect(onOrder(studioOf(buyer))).toEqual([
      expect.objectContaining({ amountFen: 200n, sourceCode: 'studio' }),
    ]);
    expect(onOrder(studioOf(rootId)).length + onOrder(studioOf(buyer)).length).toBeGreaterThan(0);
    for (const row of [...onOrder(studioOf(rootId)), ...onOrder(studioOf(buyer))]) {
      expect(row).toMatchObject({ amountFen: 200n, sourceCode: 'studio' });
    }
    expect(onOrder(cofounderOf(buyer))).toEqual([
      expect.objectContaining({ amountFen: 100n, sourceCode: 'cofounder' }),
    ]);
    expect(onOrder(cofounderOf(peer))).toEqual([
      expect.objectContaining({ amountFen: 100n, sourceCode: 'cofounder' }),
    ]);
    expect(onOrder(cofounderOf(holder))).toHaveLength(0);
    expect(stage.db.cofounderEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      2,
    );
    expect(stage.db.studioEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(2);

    const mall = await stage.catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '礼盒',
      freightFen: 0,
      priceFen: 5_000,
      pvFen: 1_000,
      stockQuantity: 1,
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
    expect(
      opsCredits(stage, holder).filter((row) => row.bizId === mallOrder.id.toString()),
    ).toEqual([
      expect.objectContaining({
        amountFen: 70n,
        bizType: 'operations_mall',
        sourceCode: 'operations',
      }),
    ]);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) =>
          row.bizId === mallOrder.id.toString() &&
          row.bizType === 'studio' &&
          row.amountFen === 20n,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      stage.db.cashLedgerEntry.rows.filter(
        (row) => typeof row.bizType === 'string' && row.bizType.startsWith('operations'),
      ),
    ).toHaveLength(0);

    const ops = new OpsOverviewService(
      stage.db as never,
      stage.clock as never,
      stage.positions,
      stage.locked,
    );
    const overview = await ops.get({ period: 'today' });
    expect(Object.keys(overview).sort()).toEqual(
      [
        'composition',
        'filing',
        'kpis',
        'organization',
        'period',
        'trend',
        'wallets',
        'withdrawals',
      ].sort(),
    );
    expect(Object.keys(overview.composition).sort()).toEqual(['cash', 'mall', 'startup']);
    expect(Object.keys(overview.composition.cash)).toEqual([
      'wechatCashInFen',
      'wechatCashRefundedFen',
      'netCashFen',
      'withdrawalPayoutFen',
      'cofounderActivationFen',
    ]);
    const overviewJson = JSON.stringify(overview, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(overviewJson).not.toContain('opsTeam');
    expect(overviewJson).not.toContain('运营团队');
    expect(overviewJson).not.toContain('operations_startup');
  });

  it('rejects locked ops-team rates on every admin settings body', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const lockedFields = {
      opsTeamStartupDividendRatioBps: 500,
      opsTeamMallDividendRatioBps: 700,
      OPS_TEAM_STARTUP_DIVIDEND_RATIO_BPS: 500,
      OPS_TEAM_MALL_DIVIDEND_RATIO_BPS: 700,
      OPS_TEAM_DIVIDEND_RATIO_BPS: 1000,
      OPERATIONS_TEAM_DIVIDEND_RATIO_BPS: 1000,
      filingDailyCheckTime: '00:01',
    };
    const bodies: Array<{ metatype: new () => object; body: Record<string, unknown> }> = [
      { metatype: UpdateStudioSettingsDto, body: { externalName: '补贴', ...lockedFields } },
      {
        metatype: UpdateCofounderSettingsDto,
        body: {
          seatCap: 100,
          userButtonOpen: false,
          activationAmountFen: '0',
          payoutMode: 'immediate',
          schedule: {
            cycle: 'daily',
            time: '00:00',
            weekday: 1,
            monthDay: 1,
            intervalDays: 7,
            anchorDate: '2026-01-01',
          },
          poolThresholdFen: '0',
          perPersonThresholdFen: '0',
          ...lockedFields,
        },
      },
      {
        metatype: UpdateCofounderContentDto,
        body: {
          entryCopy: '',
          entryImageUrls: [],
          introTitle: '',
          introBody: '',
          introImageUrls: [],
          ...lockedFields,
        },
      },
      { metatype: UpdateMarketThresholdDto, body: { value: '2000000', ...lockedFields } },
      {
        metatype: UpdateDisplayNamesDto,
        body: { items: [{ sourceCode: 'operations', displayName: '平台分红' }], ...lockedFields },
      },
      { metatype: UpdateWechatPaySettingsDto, body: { ...lockedFields } },
      { metatype: UpdateWelfareEntryDto, body: { copy: '抢红包', ...lockedFields } },
      { metatype: UpdatePayoutDateDto, body: { payoutDate: '2026-04-01', ...lockedFields } },
    ];
    for (const item of bodies) {
      await expect(
        pipe.transform(item.body, { type: 'body', metatype: item.metatype, data: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
