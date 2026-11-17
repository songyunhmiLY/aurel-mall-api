import { NotFoundException } from '@nestjs/common';
import {
  PRODUCT_ZONE_MALL,
  PRODUCT_ZONE_STARTUP,
  WARNING_PV_ABOVE_PRICE,
  warningStartupPriceForced,
} from '../src/modules/catalog/catalog.constants';
import { ROOT_INVITE_CODE } from '../src/modules/users/identity.constants';
import { Stage1Db } from './support/stage1-db';
import { UNIT_PRICE_FEN, buildStage1 } from './support/stage1-harness';

describe('catalog visibility, startup price, and admin users', () => {
  it('lists both zones in one mall for every signed-in user', async () => {
    const { catalog } = buildStage1();

    const mall = await catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '会员礼盒',
      freightFen: 800,
      priceFen: 2_000,
      pvFen: 1_000,
      stockQuantity: 4,
      status: 'on',
      body: '礼盒说明',
      coverUrl: 'https://cdn.example.com/cover.png',
      imageUrls: ['https://cdn.example.com/extra.png'],
    });
    expect(mall.warnings).toEqual([]);
    expect(mall.product.pvFen).toBe(1_000);

    // 非会员也能浏览会员商城：会员限制只在下单时校验。
    const visible = await catalog.listPublic({
      zone: PRODUCT_ZONE_MALL,
      page: 1,
      pageSize: 20,
    });
    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]).toMatchObject({
      id: mall.product.id,
      zone: PRODUCT_ZONE_MALL,
      priceFen: 2_000,
      pvFen: 1_000,
      freightFen: 800,
      stockQuantity: 4,
      coverUrl: 'https://cdn.example.com/cover.png',
      imageUrls: ['https://cdn.example.com/extra.png'],
    });
    const detail = await catalog.getPublic(mall.product.id);
    expect(detail.pvFen).toBe(1_000);

    const startup = await catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen: 0,
      stockQuantity: 2,
      status: 'on',
    });
    const startupList = await catalog.listPublic({
      zone: PRODUCT_ZONE_STARTUP,
      page: 1,
      pageSize: 20,
    });
    expect(startupList.items.map((item) => item.id)).toEqual([startup.product.id]);
    expect(startupList.items[0]).toMatchObject({ zone: PRODUCT_ZONE_STARTUP, priceFen: UNIT_PRICE_FEN });
    expect(startupList.items[0]).not.toHaveProperty('pvFen');

    // 不传 zone 与 zone=all 都是同一个混排商城，两个专区的商品都在里面。
    const mixed = await catalog.listPublic({ page: 1, pageSize: 20 });
    expect(mixed.items.map((item) => item.id)).toEqual([startup.product.id, mall.product.id]);
    const mixedAll = await catalog.listPublic({ zone: 'all', page: 1, pageSize: 20 });
    expect(mixedAll.items.map((item) => item.id)).toEqual(mixed.items.map((item) => item.id));
    expect(mixed.total).toBe(2);
  });

  it('forces startup price to N and warns when mall PV exceeds price', async () => {
    const { catalog } = buildStage1();
    const forced = await catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen: 0,
      priceFen: 1,
      stockQuantity: 1,
    });
    expect(forced.product.priceFen).toBe(UNIT_PRICE_FEN);
    expect(forced.product.pvFen).toBeNull();
    expect(forced.warnings).toEqual([warningStartupPriceForced(UNIT_PRICE_FEN)]);

    const exact = await catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装二',
      freightFen: 0,
      priceFen: UNIT_PRICE_FEN,
      stockQuantity: 1,
    });
    expect(exact.warnings).toEqual([]);
    expect(exact.product.priceFen).toBe(UNIT_PRICE_FEN);

    await expect(
      catalog.create({
        zone: PRODUCT_ZONE_STARTUP,
        name: '不能有 PV',
        freightFen: 0,
        pvFen: 100,
        stockQuantity: 1,
      }),
    ).rejects.toThrow('创业专区商品不使用 PV');

    const warned = await catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '高 PV',
      freightFen: 0,
      priceFen: 500,
      pvFen: 800,
      stockQuantity: 3,
      status: 'on',
    });
    expect(warned.warnings).toEqual([WARNING_PV_ABOVE_PRICE]);
    expect(warned.product.priceFen).toBe(500);
    expect(warned.product.pvFen).toBe(800);
    const stored = await catalog.getAdmin(warned.product.id);
    expect(stored.priceFen).toBe(500);
    expect(stored.pvFen).toBe(800);
  });

  it('shows a product to users only while it is on the shelf', async () => {
    const { catalog } = buildStage1();
    const created = await catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '待上架',
      freightFen: 100,
      stockQuantity: 6,
    });
    expect(created.product.status).toBe('draft');
    const hidden = await catalog.listPublic({
      zone: PRODUCT_ZONE_STARTUP,
      page: 1,
      pageSize: 20,
    });
    expect(hidden.items).toEqual([]);
    expect(await catalog.listAdmin({ page: 1, pageSize: 20 })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ status: 'draft' })],
    });

    await catalog.setShelf(created.product.id, 'on');
    const shown = await catalog.listPublic({
      zone: PRODUCT_ZONE_STARTUP,
      page: 1,
      pageSize: 20,
    });
    expect(shown.items).toHaveLength(1);

    const stocked = await catalog.setStock(created.product.id, 9);
    expect(stocked.stockQuantity).toBe(9);
    const off = await catalog.setShelf(created.product.id, 'off');
    expect(off.stockQuantity).toBe(9);
    expect(off.status).toBe('off');
    const after = await catalog.listPublic({
      zone: PRODUCT_ZONE_STARTUP,
      page: 1,
      pageSize: 20,
    });
    expect(after.items).toEqual([]);
    await expect(catalog.getPublic(created.product.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('sorts the mixed mall by the admin order and only feeds home-marked products', async () => {
    const { catalog } = buildStage1();
    const first = await catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '商城一',
      freightFen: 0,
      priceFen: 1_000,
      pvFen: 500,
      stockQuantity: 1,
      status: 'on',
    });
    const second = await catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen: 0,
      stockQuantity: 1,
      status: 'on',
    });
    const third = await catalog.create({
      zone: PRODUCT_ZONE_MALL,
      name: '商城二',
      freightFen: 0,
      priceFen: 2_000,
      pvFen: 900,
      stockQuantity: 1,
      status: 'on',
    });
    expect(first.product.sortOrder).toBe(0);
    expect(first.product.homeVisible).toBe(false);

    // 没有配置排序时按创建时间倒序。
    const initial = await catalog.listPublic({ page: 1, pageSize: 20 });
    expect(initial.items.map((item) => item.id)).toEqual([
      third.product.id,
      second.product.id,
      first.product.id,
    ]);

    // 管理端调小 sortOrder 就能把商品提到前面，越小的越靠前。
    await catalog.setSort(first.product.id, -20);
    await catalog.setSort(second.product.id, -10);
    const sorted = await catalog.listPublic({ page: 1, pageSize: 20 });
    expect(sorted.items.map((item) => item.id)).toEqual([
      first.product.id,
      second.product.id,
      third.product.id,
    ]);
    expect(sorted.items[0]?.sortOrder).toBe(-20);
    await expect(catalog.setSort(first.product.id, 1_000_001)).rejects.toThrow('排序不正确');

    // 首页商品流只返回勾选了「首页展示」的商品，顺序与商城一致。
    await catalog.setHomeVisible(second.product.id, true);
    await catalog.setHomeVisible(first.product.id, true);
    const home = await catalog.listPublic({ home: true, page: 1, pageSize: 20 });
    expect(home.items.map((item) => item.id)).toEqual([first.product.id, second.product.id]);
    expect(home.total).toBe(2);

    // 下架的商品即使勾了首页也不出现。
    await catalog.setShelf(second.product.id, 'off');
    const afterOff = await catalog.listPublic({ home: true, page: 1, pageSize: 20 });
    expect(afterOff.items.map((item) => item.id)).toEqual([first.product.id]);

    // 编辑表单里也能一次改排序和首页开关。
    const updated = await catalog.update(third.product.id, {
      sortOrder: -30,
      homeVisible: true,
    });
    expect(updated.product.sortOrder).toBe(-30);
    expect(updated.product.homeVisible).toBe(true);
    const homeAgain = await catalog.listPublic({ home: true, page: 1, pageSize: 20 });
    expect(homeAgain.items.map((item) => item.id)).toEqual([
      third.product.id,
      first.product.id,
    ]);
  });

  it('searches users and disable does not remove the root market seat', async () => {
    const { db, users, wechat, adminUsers } = buildStage1();
    await users.onModuleInit();
    wechat.logins.set('code-a', { openid: 'openid-a', unionid: null });
    wechat.phones.set('phone-a', '13800138000');
    const buyer = await users.loginWithMiniProgram('code-a');
    await users.bindWechatPhone(buyer.user.id, 'phone-a');
    const rootId = rootUserId(db);

    const byName = await adminUsers.list({ nickname: '根', page: 1, pageSize: 20 });
    expect(byName.items.map((item) => item.id)).toEqual([rootId]);
    expect(byName.items[0]?.member).toBe(true);
    expect(byName.items[0]?.inviteCode).toBe(ROOT_INVITE_CODE);

    const byPhone = await adminUsers.list({ phone: '13800138000', page: 1, pageSize: 20 });
    expect(byPhone.items.map((item) => item.id)).toEqual([buyer.user.id]);
    const byId = await adminUsers.list({ id: buyer.user.id, page: 1, pageSize: 20 });
    expect(byId.total).toBe(1);

    const disabled = await adminUsers.disable(rootId);
    expect(disabled.status).toBe('disabled');
    expect(disabled.member).toBe(true);
    expect(db.marketTreeNode.rows).toHaveLength(1);
    expect(db.inviteTreeNode.rows).toHaveLength(1);
    expect(db.user.rows.find((row) => row.id === rootId)?.inviteCode).toBe(ROOT_INVITE_CODE);

    const enabled = await adminUsers.enable(rootId);
    expect(enabled.status).toBe('active');
    expect(enabled.member).toBe(true);
    expect(db.marketTreeNode.rows).toHaveLength(1);
  });
});

function rootUserId(db: Stage1Db): bigint {
  const root = db.user.rows.find((row) => row.inviteCode === ROOT_INVITE_CODE);
  if (!root) {
    throw new Error('missing root');
  }
  return root.id;
}
