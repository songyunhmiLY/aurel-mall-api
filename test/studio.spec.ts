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

function studioLocked(
  startupBps: number,
  mallBps: number,
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
    studioStartupSubsidyRatioBps: startupBps,
    studioMallSubsidyRatioBps: mallBps,
  });
}

describe('studio subsidy', () => {
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

  function studioCredits(stage: Stage4, userId: bigint) {
    return stage.db.walletLedgerEntry.rows.filter(
      (row) => row.userId === userId && row.bizType === 'studio' && row.direction === 'credit',
    );
  }

  function studioSum(stage: Stage4, userId: bigint): bigint {
    return studioCredits(stage, userId).reduce((sum, row) => sum + (row.amountFen as bigint), 0n);
  }

  it('requires membership, has no cap, and does not clear cofounder enrollment', async () => {
    const stage = buildStage4(studioLocked(200, 200));
    const rootId = await boot(stage);
    const guest = await loginBuyer(stage, 'guest', rootId);
    await expect(stage.studioEnrollment.appoint(guest, 1n)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(stage.studioEnrollment.appoint(999_999n, 1n)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(stage.db.studioEnrollment.rows).toHaveLength(0);

    const productId = await startupProduct(stage, 8);
    const members: bigint[] = [];
    for (const subject of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      const userId = await loginBuyer(stage, subject, rootId);
      await buyStartup(stage, userId, productId, 1);
      members.push(userId);
    }
    const appointed = [rootId, ...members];
    for (const userId of appointed) {
      const row = await stage.studioEnrollment.appoint(userId, 7n);
      expect(row.status).toBe('active');
      expect(row.member).toBe(true);
      expect(row.cancelledAt).toBeNull();
    }
    expect(stage.db.studioEnrollment.rows).toHaveLength(appointed.length);
    await expect(stage.studioEnrollment.appoint(rootId, 7n)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const cofounder = await stage.cofounderAdmin.appoint(members[0]!, 7n);
    expect(cofounder.status).toBe('active');
    await stage.studioEnrollment.cancel(members[0]!, 7n);
    expect(
      stage.db.cofounderEnrollment.rows.filter(
        (row) => row.userId === members[0] && row.status === 'active',
      ),
    ).toHaveLength(1);
    expect(stage.db.walletLedgerEntry.rows.filter((row) => row.bizType === 'studio')).toHaveLength(
      0,
    );
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(0);

    const again = await stage.studioEnrollment.appoint(members[0]!, 8n);
    expect(again.status).toBe('active');
    expect(stage.db.studioEnrollment.rows.filter((row) => row.userId === members[0])).toHaveLength(
      2,
    );
    const active = await stage.studioEnrollment.list({ status: 'active', page: 1, pageSize: 20 });
    expect(active.total).toBe(appointed.length);
    expect(active.items.every((item) => item.status === 'active')).toBe(true);
  });

  it('credits each in-tree studio on payment and stops after cancel without a refund', async () => {
    const stage = buildStage4(studioLocked(200, 1000));
    const rootId = await boot(stage);
    const productId = await startupProduct(stage, 20, 700);
    const seated: bigint[] = [];
    for (const subject of ['a', 'b', 'c']) {
      const userId = await loginBuyer(stage, subject, rootId);
      await buyStartup(stage, userId, productId, 1);
      seated.push(userId);
    }
    const buyer = await loginBuyer(stage, 'buyer', rootId);
    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 10_000n,
      bizType: 'test_credit',
      bizId: 'cover-goods',
    });
    const seatingId = await buyStartup(stage, buyer, productId, 2);
    const seating = stage.db.order.rows.find((row) => row.id === seatingId);
    expect(seating).toMatchObject({
      goodsTotalFen: 20_000,
      freightFen: 1_400,
      payAmountFen: 21_400,
      pointsFen: 10_000,
      wechatFen: 11_400,
    });
    expect(stage.db.studioAccrual.rows).toHaveLength(0);

    const market = stage.db.marketTreeNode.rows.find((row) => row.userId === buyer);
    const invite = stage.db.inviteTreeNode.rows.find((row) => row.userId === buyer);
    const marketParent = market?.parentUserId;
    if (typeof marketParent !== 'bigint' || !invite) {
      throw new Error('missing tree');
    }
    expect(invite.parentUserId).toBe(rootId);
    expect(seated).toContain(marketParent);
    expect(marketParent).not.toBe(rootId);
    const outsiders = seated.filter((userId) => userId !== marketParent);

    await stage.studioEnrollment.appoint(rootId, 1n);
    await stage.studioEnrollment.appoint(marketParent, 1n);
    for (const userId of outsiders) {
      await stage.studioEnrollment.appoint(userId, 1n);
    }

    await stage.wallet.credit({
      userId: buyer,
      walletType: 'points',
      amountFen: 10_000n,
      bizType: 'test_credit',
      bizId: 'cover-goods-2',
    });
    const startupId = await buyStartup(stage, buyer, productId, 2);
    const startup = stage.db.order.rows.find((row) => row.id === startupId);
    expect(startup?.goodsTotalFen).toBe(20_000);
    expect(startup?.wechatFen).not.toBe(20_000);
    const startupAccruals = stage.db.studioAccrual.rows.filter((row) => row.orderId === startupId);
    expect(startupAccruals).toHaveLength(2);
    for (const row of startupAccruals) {
      expect(row).toMatchObject({
        zone: PRODUCT_ZONE_STARTUP,
        baseField: 'goods_total_fen',
        baseFen: 20_000n,
        ratioBps: 200,
        amountFen: 400n,
      });
    }
    expect(studioSum(stage, rootId)).toBe(400n);
    expect(studioSum(stage, marketParent)).toBe(400n);
    for (const userId of outsiders) {
      expect(studioSum(stage, userId)).toBe(0n);
    }
    expect(studioSum(stage, buyer)).toBe(0n);
    expect(
      studioCredits(stage, rootId).every(
        (row) => row.walletType === 'withdrawable' && row.sourceCode === 'studio',
      ),
    ).toBe(true);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.bizType === 'studio' && row.walletType !== 'withdrawable',
      ),
    ).toHaveLength(0);

    await stage.studioEnrollment.appoint(buyer, 1n);
    const ownId = await buyStartup(stage, buyer, productId, 1);
    expect(studioCredits(stage, buyer).filter((row) => row.bizId === ownId.toString())).toEqual([
      expect.objectContaining({
        amountFen: 200n,
        walletType: 'withdrawable',
        sourceCode: 'studio',
      }),
    ]);
    expect(studioCredits(stage, rootId).filter((row) => row.bizId === ownId.toString())).toEqual([
      expect.objectContaining({ amountFen: 200n }),
    ]);
    expect(
      studioCredits(stage, marketParent).filter((row) => row.bizId === ownId.toString()),
    ).toEqual([expect.objectContaining({ amountFen: 200n })]);
    for (const userId of outsiders) {
      expect(
        studioCredits(stage, userId).filter((row) => row.bizId === ownId.toString()),
      ).toHaveLength(0);
    }

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
    expect(mallRow?.goodsTotalFen).toBe(5_000);
    const mallAccruals = stage.db.studioAccrual.rows.filter((row) => row.orderId === mallOrder.id);
    expect(mallAccruals.map((row) => (row.userId as bigint).toString()).sort()).toEqual(
      [rootId.toString(), buyer.toString()].sort(),
    );
    for (const row of mallAccruals) {
      expect(row).toMatchObject({
        zone: PRODUCT_ZONE_MALL,
        baseField: 'pv_fen',
        baseFen: 300n,
        ratioBps: 1000,
        amountFen: 30n,
      });
    }
    expect(
      studioCredits(stage, marketParent).filter((row) => row.bizId === mallOrder.id.toString()),
    ).toHaveLength(0);

    const kept = studioSum(stage, marketParent);
    const balance = stage.db.walletAccount.rows.find(
      (row) => row.userId === marketParent && row.walletType === 'withdrawable',
    )?.balanceFen;
    const cancelled = await stage.studioEnrollment.cancel(marketParent, 9n);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(studioSum(stage, marketParent)).toBe(kept);
    expect(
      stage.db.walletLedgerEntry.rows.filter(
        (row) =>
          row.userId === marketParent && row.bizType === 'studio' && row.direction === 'debit',
      ),
    ).toHaveLength(0);
    expect(
      stage.db.walletAccount.rows.find(
        (row) => row.userId === marketParent && row.walletType === 'withdrawable',
      )?.balanceFen,
    ).toBe(balance);
    expect(stage.db.cashLedgerEntry.rows.filter((row) => row.bizType === 'studio')).toHaveLength(0);

    const afterCancel = await buyStartup(stage, buyer, productId, 1);
    expect(
      studioCredits(stage, marketParent).filter((row) => row.bizId === afterCancel.toString()),
    ).toHaveLength(0);
    expect(
      studioCredits(stage, rootId).filter((row) => row.bizId === afterCancel.toString()),
    ).toHaveLength(1);
    expect(
      studioCredits(stage, buyer).filter((row) => row.bizId === afterCancel.toString()),
    ).toHaveLength(1);
    expect(studioSum(stage, marketParent)).toBe(kept);

    await stage.db.$transaction(async (tx) => {
      await stage.studioSubsidy.onPaidOrder(
        tx as never,
        {
          id: afterCancel,
          userId: buyer,
          zone: PRODUCT_ZONE_STARTUP,
          goodsTotalFen: 10_000,
          pvFen: 0,
        },
        stage.clock.current,
      );
    });
    expect(
      studioCredits(stage, rootId).filter((row) => row.bizId === afterCancel.toString()),
    ).toHaveLength(1);

    const categories = await stage.displayNames.categoriesForUser(rootId);
    expect(categories.categories.find((row) => row.displayName === '系统激励')).toMatchObject({
      totalFen: studioSum(stage, rootId),
      sourceCodes: ['studio'],
    });
    expect(
      stage.db.rewardLedgerEntry.rows.filter((row) => row.rewardType === 'studio').length,
    ).toBe(stage.db.studioAccrual.rows.length);
  });

  it('still pays cofounder dividends on the same order', async () => {
    const stage = buildStage4(studioLocked(200, 200, 200, 200));
    const rootId = await boot(stage);
    const productId = await startupProduct(stage, 6, 0);
    const buyer = await loginBuyer(stage, 'buyer', rootId);
    const peer = await loginBuyer(stage, 'peer', rootId);
    await buyStartup(stage, buyer, productId, 1);
    await buyStartup(stage, peer, productId, 1);
    await stage.cofounderAdmin.appoint(buyer, 1n);
    await stage.cofounderAdmin.appoint(peer, 1n);
    await stage.studioEnrollment.appoint(rootId, 1n);
    await stage.studioEnrollment.appoint(buyer, 1n);
    expect(stage.db.cofounderEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      2,
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

    expect(studioCredits(stage, rootId).filter((row) => row.bizId === orderId.toString())).toEqual([
      expect.objectContaining({ amountFen: 200n, sourceCode: 'studio' }),
    ]);
    expect(studioCredits(stage, buyer).filter((row) => row.bizId === orderId.toString())).toEqual([
      expect.objectContaining({ amountFen: 200n, sourceCode: 'studio' }),
    ]);
    expect(studioCredits(stage, peer)).toHaveLength(0);

    const cofounderOf = (userId: bigint) =>
      stage.db.walletLedgerEntry.rows.filter(
        (row) => row.userId === userId && row.bizType === 'cofounder' && row.direction === 'credit',
      );
    expect(cofounderOf(buyer)).toEqual([
      expect.objectContaining({
        amountFen: 100n,
        sourceCode: 'cofounder',
        walletType: 'withdrawable',
      }),
    ]);
    expect(cofounderOf(peer)).toEqual([
      expect.objectContaining({ amountFen: 100n, sourceCode: 'cofounder' }),
    ]);
    expect(cofounderOf(rootId)).toHaveLength(0);
    const review = await stage.cofounderReview.review(buyer);
    expect(review.enrolled).toBe(true);
    expect(review.cofounderDividendFen).toBe(100n);
    expect(review.awards.find((row) => row.rewardType === 'studio')).toEqual({
      rewardType: 'studio',
      label: '工作室补贴',
      amountFen: 200n,
    });
    expect(stage.db.cofounderEnrollment.rows.filter((row) => row.status === 'active')).toHaveLength(
      2,
    );
    expect(stage.db.cashLedgerEntry.rows).toHaveLength(0);

    const ops = new OpsOverviewService(
      stage.db as never,
      stage.clock as never,
      stage.positions,
      stage.locked,
    );
    const overview = await ops.get({ period: 'today' });
    expect(overview.composition.cash).toEqual({
      wechatCashInFen: 20_000n,
      wechatCashRefundedFen: 0n,
      netCashFen: 20_000n,
      withdrawalPayoutFen: 0n,
      cofounderActivationFen: 0n,
    });
    expect(overview.kpis.wechatCash.cashInFen).toBe(20_000n);
    expect(Object.keys(overview.composition.cash)).not.toContain('studio');
  });

  it('keeps the external name configurable and rejects locked rates on admin settings', async () => {
    const stage = buildStage4(studioLocked(200, 200));
    expect(await stage.studioSettings.getExternalName()).toBe('补贴');
    expect(await stage.studioSettings.setExternalName('  津贴  ', 3n)).toEqual({
      externalName: '津贴',
    });
    expect(await stage.studioSettings.getExternalName()).toBe('津贴');
    await expect(stage.studioSettings.setExternalName('   ', 3n)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const sources = await stage.displayNames.listSources();
    expect(sources.items.find((item) => item.sourceCode === 'studio')?.displayName).toBe(
      '系统激励',
    );

    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        { externalName: '补贴' },
        { type: 'body', metatype: UpdateStudioSettingsDto, data: '' },
      ),
    ).resolves.toEqual({ externalName: '补贴' });

    const lockedFields = {
      studioStartupSubsidyRatioBps: 200,
      studioMallSubsidyRatioBps: 200,
      STUDIO_STARTUP_SUBSIDY_RATIO_BPS: 200,
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
        body: { items: [{ sourceCode: 'studio', displayName: '系统激励' }], ...lockedFields },
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
