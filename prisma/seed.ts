/**
 * 开发与演示用的基础数据。
 *
 * 仓库原本没有种子脚本：空库启动后首页全空、没有商品、没有可用的邀请码，
 * 连会员都注册不了 —— 也就没法验证支付、入座、奖励、提现这条链路。
 *
 * 这里不重新实现业务规则，而是启动一个 Nest 应用上下文，
 * 直接调用真实的 UsersService / TreesService，保证写入的数据和线上路径一致。
 *
 * 用法：npm run db:seed
 * 幂等：已存在的管理员、商品、会员不会重复创建。
 */
import { NestFactory } from '@nestjs/core';
import { hash } from 'argon2';
import type { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { ADMIN_STATUS_ACTIVE } from '../src/common/auth/admin-jwt.guard';
import { ClockService } from '../src/common/clock/clock.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { APP_ENV } from '../src/config/tokens';
import type { AppEnv } from '../src/config/app-env';
import {
  PRODUCT_STATUS_ON,
  PRODUCT_ZONE_MALL,
  PRODUCT_ZONE_STARTUP,
} from '../src/modules/catalog/catalog.constants';
import { TreesService } from '../src/modules/rewards/trees/trees.service';
import { UsersService } from '../src/modules/users/users.service';
import { ROOT_INVITE_CODE } from '../src/modules/users/identity.constants';

const DEFAULT_MEMBER_COUNT = 27;

interface SeedStats {
  admin: 'created' | 'exists';
  startupProducts: number;
  mallProducts: number;
  members: number;
}

async function main(): Promise<void> {
  const memberCount = readMemberCount();
  process.env.ALLOW_PREVIEW_AUTH = 'true';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const clock = app.get(ClockService);
    const users = app.get(UsersService);
    const trees = app.get(TreesService);
    const env = app.get<AppEnv>(APP_ENV);

    const stats: SeedStats = {
      admin: await seedAdmin(prisma, clock, env),
      startupProducts: await seedStartupZone(prisma, clock, env),
      mallProducts: 0,
      members: 0,
    };
    stats.mallProducts = await seedMall(prisma, clock);
    stats.members = await seedMembers(prisma, clock, users, trees, memberCount);
    printStats(stats, env);
  } finally {
    await app.close();
  }
}

async function seedAdmin(
  prisma: PrismaClient,
  clock: ClockService,
  env: AppEnv,
): Promise<'created' | 'exists'> {
  const username = env.adminBootstrapUsername ?? 'admin';
  const password = env.adminBootstrapPassword ?? 'Admin@123456';
  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    return 'exists';
  }
  const now = await clock.now();
  await prisma.adminUser.create({
    data: {
      username,
      passwordHash: await hash(password),
      displayName: env.adminBootstrapDisplayName ?? '超级管理员',
      status: ADMIN_STATUS_ACTIVE,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (!env.adminBootstrapPassword) {
    console.warn(`未设置 ADMIN_BOOTSTRAP_PASSWORD，已使用默认密码 ${password}，仅限本地环境。`);
  }
  return 'created';
}

async function seedStartupZone(
  prisma: PrismaClient,
  clock: ClockService,
  env: AppEnv,
): Promise<number> {
  const unitPriceFen = env.locked.startupZoneUnitPriceFen;
  const existing = await prisma.product.findFirst({ where: { zone: PRODUCT_ZONE_STARTUP } });
  if (existing) {
    return 1;
  }
  const now = await clock.now();
  const product = await prisma.product.create({
    data: {
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业专区礼包',
      subtitle: `入会礼包，单价 ${(unitPriceFen / 100).toFixed(2)} 元`,
      body: '创业专区只展示这一件商品。支付成功后获得席位，并开始参与报单与计酬。',
      coverUrl: null,
      freightFen: 0,
      categoryId: null,
      status: PRODUCT_STATUS_ON,
      // 种子商品默认上首页，排序 0 让创业专区排在混排列表最前。
      sortOrder: 0,
      homeVisible: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  const sku = await prisma.productSku.create({
    data: {
      productId: product.id,
      skuCode: 'SEED-STARTUP-001',
      name: '创业专区礼包',
      priceFen: unitPriceFen,
      pvFen: null,
      status: PRODUCT_STATUS_ON,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.skuStock.create({
    data: { skuId: sku.id, quantity: 100_000, updatedAt: now },
  });
  return 1;
}

const MALL_CATEGORY_NAMES = ['粮油副食', '家居日用', '健康轻食'] as const;

const MALL_PRODUCTS: ReadonlyArray<{ name: string; priceFen: number; category: number }> = [
  { name: '东北五常大米 5kg', priceFen: 9_900, category: 0 },
  { name: '初榨橄榄油 1L', priceFen: 12_800, category: 0 },
  { name: '竹纤维抽纸 24 包', priceFen: 5_990, category: 1 },
  { name: '不锈钢保温杯 500ml', priceFen: 8_800, category: 1 },
  { name: '冻干水果脆片 6 袋', priceFen: 6_900, category: 2 },
  { name: '低 GI 代餐粉 20 条', priceFen: 15_900, category: 2 },
];

async function seedMall(prisma: PrismaClient, clock: ClockService): Promise<number> {
  const existing = await prisma.product.count({ where: { zone: PRODUCT_ZONE_MALL } });
  if (existing > 0) {
    return existing;
  }
  const now = await clock.now();
  const categories: bigint[] = [];
  for (let index = 0; index < MALL_CATEGORY_NAMES.length; index += 1) {
    const category = await prisma.mallCategory.create({
      data: {
        name: MALL_CATEGORY_NAMES[index]!,
        sortOrder: index + 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    categories.push(category.id);
  }
  for (let index = 0; index < MALL_PRODUCTS.length; index += 1) {
    const item = MALL_PRODUCTS[index]!;
    const product = await prisma.product.create({
      data: {
        zone: PRODUCT_ZONE_MALL,
        name: item.name,
        subtitle: '会员商城',
        body: '演示用商品，可直接下单并用沙箱支付完成结算。',
        coverUrl: null,
        freightFen: 0,
        categoryId: categories[item.category] ?? null,
        status: PRODUCT_STATUS_ON,
        // 种子商品按数组顺序给一个递增排序，默认全部上首页。
        sortOrder: index + 1,
        homeVisible: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    const sku = await prisma.productSku.create({
      data: {
        productId: product.id,
        skuCode: `SEED-MALL-${String(index + 1).padStart(3, '0')}`,
        name: item.name,
        priceFen: item.priceFen,
        pvFen: item.priceFen,
        status: PRODUCT_STATUS_ON,
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.skuStock.create({
      data: { skuId: sku.id, quantity: 9_999, updatedAt: now },
    });
  }
  return MALL_PRODUCTS.length;
}

/**
 * 按三三复制铺满前三层：1 个根 → 3 个 → 9 个 → 再往下 14 个。
 * 走的是真实的绑定邀请与入座逻辑，因此邀请树、市场树、槽位表都是自洽的。
 */
async function seedMembers(
  prisma: PrismaClient,
  clock: ClockService,
  users: UsersService,
  trees: TreesService,
  target: number,
): Promise<number> {
  const root = await prisma.user.findUnique({ where: { inviteCode: ROOT_INVITE_CODE } });
  if (!root) {
    throw new Error('缺少官方根账户，请先启动一次 API 让 UsersService 完成初始化');
  }
  const inviteCodes = new Map<bigint, string>([[root.id, ROOT_INVITE_CODE]]);
  const order: bigint[] = [root.id];
  let cursor = 0;
  let filled = 0;
  let created = 0;

  for (let index = 0; index < target; index += 1) {
    const subject = `seed${String(index + 1).padStart(2, '0')}`;
    const parentId = order[cursor]!;
    const parentCode = inviteCodes.get(parentId)!;
    const session = await users.loginPreview(subject);
    const userId = session.user.id;
    if (await prisma.marketTreeNode.findUnique({ where: { userId } })) {
      continue;
    }
    await users.bindInviter(userId, parentCode);
    const now = await clock.now();
    await prisma.$transaction(async (tx) => {
      await trees.seat(tx, userId, now);
    });
    const seated = await prisma.user.findUnique({ where: { id: userId } });
    if (!seated?.inviteCode) {
      throw new Error(`会员 ${subject} 入座后没有邀请码`);
    }
    inviteCodes.set(userId, seated.inviteCode);
    order.push(userId);
    created += 1;
    filled += 1;
    if (filled === 3) {
      filled = 0;
      cursor += 1;
    }
  }
  return created;
}

function readMemberCount(): number {
  const raw = process.argv.find((item) => item.startsWith('--members='));
  if (!raw) {
    return DEFAULT_MEMBER_COUNT;
  }
  const value = Number(raw.split('=')[1]);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error('--members 只能是 1 到 500 之间的整数');
  }
  return value;
}

function printStats(stats: SeedStats, env: AppEnv): void {
  const lines = [
    '',
    '种子数据完成',
    `  管理员      ${stats.admin === 'created' ? '已创建' : '已存在'}`,
    `  创业专区商品 ${stats.startupProducts}`,
    `  商城商品     ${stats.mallProducts}`,
    `  新入座会员   ${stats.members}`,
    '',
    `  后台账号：${env.adminBootstrapUsername ?? 'admin'}`,
    `  会员邀请码：${ROOT_INVITE_CODE}（官方根账户）`,
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
