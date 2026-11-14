import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { MallCategory, Product, ProductImage, ProductSku, SkuStock } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { UsersService } from '../users/users.service';
import {
  PRODUCT_STATUS_DRAFT,
  PRODUCT_STATUS_OFF,
  PRODUCT_STATUS_ON,
  PRODUCT_STATUSES,
  PRODUCT_ZONE_MALL,
  PRODUCT_ZONE_STARTUP,
  PRODUCT_ZONES,
  WARNING_PV_ABOVE_PRICE,
  assertNonNegativeInt,
  warningStartupPriceForced,
} from './catalog.constants';

const MAX_IMAGES = 20;
const MAX_BODY = 20_000;

export interface CategoryBrief {
  id: bigint;
  name: string;
  sortOrder: number;
}

export interface PublicProductView {
  id: bigint;
  zone: string;
  name: string;
  subtitle: string | null;
  body: string | null;
  coverUrl: string | null;
  imageUrls: string[];
  freightFen: number;
  priceFen: number;
  stockQuantity: number;
  category: CategoryBrief | null;
  pvFen?: number;
}

export interface AdminProductView {
  id: bigint;
  zone: string;
  name: string;
  subtitle: string | null;
  body: string | null;
  coverUrl: string | null;
  imageUrls: string[];
  freightFen: number;
  priceFen: number;
  pvFen: number | null;
  /** 含运费的进货成本，可空。未设置时利润口径按 0 计。 */
  costFen: number | null;
  stockQuantity: number;
  status: string;
  skuId: bigint;
  categoryId: bigint | null;
  category: CategoryBrief | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductWriteResult {
  product: AdminProductView;
  warnings: string[];
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateProductInput {
  zone: string;
  name: string;
  subtitle?: string | null;
  body?: string | null;
  coverUrl?: string | null;
  imageUrls?: string[];
  freightFen: number;
  priceFen?: number;
  pvFen?: number | null;
  costFen?: number | null;
  categoryId?: bigint | null;
  stockQuantity: number;
  status?: string;
}

export interface UpdateProductInput {
  name?: string;
  subtitle?: string | null;
  body?: string | null;
  coverUrl?: string | null;
  imageUrls?: string[];
  freightFen?: number;
  priceFen?: number;
  pvFen?: number | null;
  costFen?: number | null;
  categoryId?: bigint | null;
  status?: string;
}

export interface CategoryView {
  id: bigint;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface ResolvedCommerce {
  priceFen: number;
  pvFen: number | null;
  warnings: string[];
}

/**
 * 每个商品恰好一个 SKU。用户接口只返回上架商品。
 * 会员商城还要求用户行上的会员标记。库存由订单在支付成功时扣减。
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly users: UsersService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
  ) {}

  async listPublic(
    userId: bigint,
    query: { zone: string; categoryId?: bigint; page: number; pageSize: number },
  ): Promise<PageResult<PublicProductView>> {
    const zone = parseZone(query.zone);
    if (zone === PRODUCT_ZONE_MALL) {
      await this.assertMember(userId);
    } else if (query.categoryId !== undefined) {
      throw new BadRequestException('创业专区没有分类');
    }
    if (query.categoryId !== undefined) {
      await this.requireCategory(query.categoryId);
    }
    const where: Prisma.ProductWhereInput = {
      zone,
      status: PRODUCT_STATUS_ON,
      ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
    };
    const page = await this.pageProducts(where, query.page, query.pageSize);
    return { ...page, items: page.items.map(toPublic) };
  }

  async getPublic(userId: bigint, id: bigint): Promise<PublicProductView> {
    const product = await this.requireProduct(id);
    if (product.zone === PRODUCT_ZONE_MALL) {
      await this.assertMember(userId);
    }
    if (product.status !== PRODUCT_STATUS_ON) {
      throw new NotFoundException('商品不存在');
    }
    const [view] = await this.hydrate([product]);
    if (!view) {
      throw new NotFoundException('商品不存在');
    }
    return toPublic(view);
  }

  async listAdmin(query: {
    zone?: string;
    status?: string;
    categoryId?: bigint;
    page: number;
    pageSize: number;
  }): Promise<PageResult<AdminProductView>> {
    const where: Prisma.ProductWhereInput = {};
    if (query.zone !== undefined) {
      where.zone = parseZone(query.zone);
    }
    if (query.status !== undefined) {
      where.status = parseStatus(query.status);
    }
    if (query.categoryId !== undefined) {
      if (where.zone === PRODUCT_ZONE_STARTUP) {
        throw new BadRequestException('创业专区没有分类');
      }
      where.categoryId = query.categoryId;
    }
    return this.pageProducts(where, query.page, query.pageSize);
  }

  async getAdmin(id: bigint): Promise<AdminProductView> {
    const product = await this.requireProduct(id);
    const [view] = await this.hydrate([product]);
    if (!view) {
      throw new NotFoundException('商品不存在');
    }
    return view;
  }

  async create(input: CreateProductInput): Promise<ProductWriteResult> {
    const zone = parseZone(input.zone);
    const fields = this.readContent(input, true);
    const commerce = this.resolveCommerce(zone, input.priceFen, input.pvFen, null, null);
    const categoryId = await this.resolveCategory(zone, input.categoryId, null);
    const status = input.status === undefined ? PRODUCT_STATUS_DRAFT : parseStatus(input.status);
    const now = await this.clock.now();
    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          zone,
          name: fields.name,
          subtitle: fields.subtitle,
          body: fields.body,
          coverUrl: fields.coverUrl,
          freightFen: fields.freightFen,
          categoryId,
          status,
          createdAt: now,
          updatedAt: now,
        },
      });
      const sku = await tx.productSku.create({
        data: {
          productId: created.id,
          skuCode: `S${created.id.toString()}`,
          name: fields.name,
          priceFen: commerce.priceFen,
          pvFen: commerce.pvFen,
          costFen: readCostFen(input.costFen),
          status,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.skuStock.create({
        data: { skuId: sku.id, quantity: fields.stockQuantity, updatedAt: now },
      });
      await replaceImages(tx, created.id, fields.imageUrls, now);
      return created;
    });
    return { product: await this.getAdmin(product.id), warnings: commerce.warnings };
  }

  async update(id: bigint, input: UpdateProductInput): Promise<ProductWriteResult> {
    const current = await this.getAdmin(id);
    const content = this.readContent(
      {
        name: input.name ?? current.name,
        subtitle: input.subtitle === undefined ? current.subtitle : input.subtitle,
        body: input.body === undefined ? current.body : input.body,
        coverUrl: input.coverUrl === undefined ? current.coverUrl : input.coverUrl,
        imageUrls: input.imageUrls,
        freightFen: input.freightFen ?? current.freightFen,
        stockQuantity: current.stockQuantity,
      },
      input.name !== undefined,
    );
    const name = input.name === undefined ? current.name : content.name;
    const commerce = this.resolveCommerce(
      current.zone,
      input.priceFen,
      input.pvFen,
      current.priceFen,
      current.pvFen,
    );
    const categoryId = await this.resolveCategory(
      current.zone,
      input.categoryId,
      current.categoryId,
    );
    const status = input.status === undefined ? current.status : parseStatus(input.status);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          name,
          subtitle: input.subtitle === undefined ? current.subtitle : content.subtitle,
          body: input.body === undefined ? current.body : content.body,
          coverUrl: input.coverUrl === undefined ? current.coverUrl : content.coverUrl,
          freightFen: input.freightFen === undefined ? current.freightFen : content.freightFen,
          categoryId,
          status,
          updatedAt: now,
        },
      });
      await tx.productSku.update({
        where: { id: current.skuId },
        data: {
          name,
          priceFen: commerce.priceFen,
          pvFen: commerce.pvFen,
          ...(input.costFen === undefined ? {} : { costFen: readCostFen(input.costFen) }),
          status,
          updatedAt: now,
        },
      });
      if (input.imageUrls !== undefined) {
        await replaceImages(tx, id, content.imageUrls, now);
      }
    });
    return { product: await this.getAdmin(id), warnings: commerce.warnings };
  }

  async setShelf(id: bigint, status: string): Promise<AdminProductView> {
    if (status !== PRODUCT_STATUS_ON && status !== PRODUCT_STATUS_OFF) {
      throw new BadRequestException('上下架状态只能是 on 或 off');
    }
    const current = await this.getAdmin(id);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { status, updatedAt: now } });
      await tx.productSku.update({
        where: { id: current.skuId },
        data: { status, updatedAt: now },
      });
    });
    return this.getAdmin(id);
  }

  /** 把可售数量设成给定值。不扣减，也不做预占。 */
  async setStock(id: bigint, quantity: number): Promise<AdminProductView> {
    const stockQuantity = assertNonNegativeInt(quantity, '库存');
    const current = await this.getAdmin(id);
    const now = await this.clock.now();
    await this.prisma.skuStock.update({
      where: { skuId: current.skuId },
      data: { quantity: stockQuantity, updatedAt: now },
    });
    return this.getAdmin(id);
  }

  async listCategories(): Promise<CategoryView[]> {
    const rows = await this.prisma.mallCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toCategory);
  }

  async createCategory(input: { name: string; sortOrder?: number }): Promise<CategoryView> {
    const name = requiredName(input.name, '分类名称', 64);
    const sortOrder = input.sortOrder === undefined ? 0 : assertSort(input.sortOrder);
    const now = await this.clock.now();
    const row = await this.prisma.mallCategory.create({
      data: { name, sortOrder, createdAt: now, updatedAt: now },
    });
    return toCategory(row);
  }

  async updateCategory(
    id: bigint,
    input: { name?: string; sortOrder?: number },
  ): Promise<CategoryView> {
    const current = await this.prisma.mallCategory.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException('分类不存在');
    }
    const now = await this.clock.now();
    const row = await this.prisma.mallCategory.update({
      where: { id },
      data: {
        name: input.name === undefined ? current.name : requiredName(input.name, '分类名称', 64),
        sortOrder: input.sortOrder === undefined ? current.sortOrder : assertSort(input.sortOrder),
        updatedAt: now,
      },
    });
    return toCategory(row);
  }

  private async pageProducts(
    where: Prisma.ProductWhereInput,
    page: number,
    pageSize: number,
  ): Promise<PageResult<AdminProductView>> {
    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: await this.hydrate(rows), total, page, pageSize };
  }

  private async hydrate(products: Product[]): Promise<AdminProductView[]> {
    if (products.length === 0) {
      return [];
    }
    const productIds = products.map((product) => product.id);
    const skus = await this.prisma.productSku.findMany({
      where: { productId: { in: productIds } },
    });
    const skuIds = skus.map((sku) => sku.id);
    const stocks =
      skuIds.length === 0
        ? []
        : await this.prisma.skuStock.findMany({ where: { skuId: { in: skuIds } } });
    const images = await this.prisma.productImage.findMany({
      where: { productId: { in: productIds } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const categoryIds = [
      ...new Set(
        products.flatMap((product) => (product.categoryId === null ? [] : [product.categoryId])),
      ),
    ];
    const categories =
      categoryIds.length === 0
        ? []
        : await this.prisma.mallCategory.findMany({ where: { id: { in: categoryIds } } });
    const skuByProduct = groupSkus(skus);
    const stockBySku = new Map(stocks.map((stock) => [stock.skuId.toString(), stock]));
    const imagesByProduct = groupImages(images);
    const categoryById = new Map(categories.map((category) => [category.id.toString(), category]));
    return products.map((product) => {
      const sku = singleSku(skuByProduct.get(product.id.toString()) ?? []);
      const stock = stockBySku.get(sku.id.toString());
      if (!stock) {
        throw new InternalServerErrorException('商品缺少库存');
      }
      const category =
        product.categoryId === null
          ? null
          : (categoryById.get(product.categoryId.toString()) ?? null);
      return toAdmin(
        product,
        sku,
        stock,
        imagesByProduct.get(product.id.toString()) ?? [],
        category,
      );
    });
  }

  private readContent(
    input: {
      name?: string;
      subtitle?: string | null;
      body?: string | null;
      coverUrl?: string | null;
      imageUrls?: string[];
      freightFen: number;
      stockQuantity: number;
    },
    requireName: boolean,
  ): {
    name: string;
    subtitle: string | null;
    body: string | null;
    coverUrl: string | null;
    imageUrls: string[];
    freightFen: number;
    stockQuantity: number;
  } {
    const name = input.name === undefined ? '' : requiredName(input.name, '商品名称', 128);
    if (requireName && name.length < 1) {
      throw new BadRequestException('商品名称不正确');
    }
    return {
      name,
      subtitle: optionalText(input.subtitle, '副标题', 255),
      body: optionalText(input.body, '详情', MAX_BODY),
      coverUrl: optionalUrl(input.coverUrl, '封面'),
      imageUrls:
        input.imageUrls === undefined
          ? []
          : input.imageUrls.map((url, index) => parseUrl(url, `附图${index + 1}`)),
      freightFen: assertNonNegativeInt(input.freightFen, '运费'),
      stockQuantity: assertNonNegativeInt(input.stockQuantity, '库存'),
    };
  }

  private resolveCommerce(
    zone: string,
    priceInput: number | undefined,
    pvInput: number | null | undefined,
    currentPrice: number | null,
    currentPv: number | null,
  ): ResolvedCommerce {
    if (zone === PRODUCT_ZONE_STARTUP) {
      if (pvInput !== undefined) {
        throw new BadRequestException('创业专区商品不使用 PV');
      }
      const locked = this.locked.startupZoneUnitPriceFen;
      const warnings: string[] = [];
      if (priceInput !== undefined) {
        assertNonNegativeInt(priceInput, '售价');
        if (priceInput !== locked) {
          warnings.push(warningStartupPriceForced(locked));
        }
      }
      return { priceFen: locked, pvFen: null, warnings };
    }
    if (zone !== PRODUCT_ZONE_MALL) {
      throw new BadRequestException('专区不正确');
    }
    if (pvInput === null) {
      throw new BadRequestException('商城商品必须填写 PV');
    }
    const priceFen =
      priceInput === undefined ? currentPrice : assertNonNegativeInt(priceInput, '售价');
    const pvFen = pvInput === undefined ? currentPv : assertNonNegativeInt(pvInput, 'PV');
    if (priceFen === null) {
      throw new BadRequestException('商城商品必须填写售价');
    }
    if (pvFen === null) {
      throw new BadRequestException('商城商品必须填写 PV');
    }
    const warnings = pvFen > priceFen ? [WARNING_PV_ABOVE_PRICE] : [];
    return { priceFen, pvFen, warnings };
  }

  private async resolveCategory(
    zone: string,
    categoryId: bigint | null | undefined,
    current: bigint | null,
  ): Promise<bigint | null> {
    if (zone === PRODUCT_ZONE_STARTUP) {
      if (categoryId !== undefined && categoryId !== null) {
        throw new BadRequestException('创业专区没有分类');
      }
      return null;
    }
    if (categoryId === undefined) {
      return current;
    }
    if (categoryId === null) {
      return null;
    }
    await this.requireCategory(categoryId);
    return categoryId;
  }

  private async requireCategory(id: bigint): Promise<MallCategory> {
    const category = await this.prisma.mallCategory.findUnique({ where: { id } });
    if (!category) {
      throw new BadRequestException('分类不存在');
    }
    return category;
  }

  private async requireProduct(id: bigint): Promise<Product> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    return product;
  }

  private async assertMember(userId: bigint): Promise<void> {
    if (!(await this.users.isMember(userId))) {
      throw new ForbiddenException('非会员不能浏览会员商城');
    }
  }
}

function parseZone(zone: string): string {
  if (!(PRODUCT_ZONES as readonly string[]).includes(zone)) {
    throw new BadRequestException('专区不正确');
  }
  return zone;
}

/** 成本价可空；给值时必须是不小于 0 的整数（分）。 */
function readCostFen(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return assertNonNegativeInt(value, '成本价');
}

function parseStatus(status: string): string {
  if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException('商品状态不正确');
  }
  return status;
}

function requiredName(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new BadRequestException(`${label}不正确`);
  }
  return trimmed;
}

function optionalText(value: string | null | undefined, label: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > max) {
    throw new BadRequestException(`${label}不正确`);
  }
  return trimmed;
}

function optionalUrl(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  return parseUrl(value, label);
}

function parseUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 512) {
    throw new BadRequestException(`${label}不正确`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BadRequestException(`${label}必须是 URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException(`${label}必须是 http 或 https`);
  }
  return trimmed;
}

function assertSort(value: number): number {
  if (!Number.isInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw new BadRequestException('排序不正确');
  }
  return value;
}

function toPublic(product: AdminProductView): PublicProductView {
  const view: PublicProductView = {
    id: product.id,
    zone: product.zone,
    name: product.name,
    subtitle: product.subtitle,
    body: product.body,
    coverUrl: product.coverUrl,
    imageUrls: product.imageUrls,
    freightFen: product.freightFen,
    priceFen: product.priceFen,
    stockQuantity: product.stockQuantity,
    category: product.category,
  };
  if (product.zone === PRODUCT_ZONE_MALL && product.pvFen !== null) {
    view.pvFen = product.pvFen;
  }
  return view;
}

function toAdmin(
  product: Product,
  sku: ProductSku,
  stock: SkuStock,
  images: ProductImage[],
  category: MallCategory | null,
): AdminProductView {
  return {
    id: product.id,
    zone: product.zone,
    name: product.name,
    subtitle: product.subtitle,
    body: product.body,
    coverUrl: product.coverUrl,
    imageUrls: images.map((image) => image.url),
    freightFen: product.freightFen,
    priceFen: sku.priceFen,
    pvFen: sku.pvFen,
    costFen: sku.costFen,
    stockQuantity: stock.quantity,
    status: product.status,
    skuId: sku.id,
    categoryId: product.categoryId,
    category: category
      ? { id: category.id, name: category.name, sortOrder: category.sortOrder }
      : null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toCategory(row: MallCategory): CategoryView {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function groupSkus(skus: ProductSku[]): Map<string, ProductSku[]> {
  const grouped = new Map<string, ProductSku[]>();
  for (const sku of skus) {
    const key = sku.productId.toString();
    const list = grouped.get(key);
    if (list) {
      list.push(sku);
    } else {
      grouped.set(key, [sku]);
    }
  }
  return grouped;
}

function groupImages(images: ProductImage[]): Map<string, ProductImage[]> {
  const grouped = new Map<string, ProductImage[]>();
  for (const image of images) {
    const key = image.productId.toString();
    const list = grouped.get(key);
    if (list) {
      list.push(image);
    } else {
      grouped.set(key, [image]);
    }
  }
  return grouped;
}

function singleSku(skus: ProductSku[]): ProductSku {
  if (skus.length !== 1) {
    throw new InternalServerErrorException(skus.length === 0 ? '商品缺少 SKU' : '商品存在多个 SKU');
  }
  const sku = skus[0];
  if (!sku) {
    throw new InternalServerErrorException('商品缺少 SKU');
  }
  return sku;
}

async function replaceImages(
  tx: Prisma.TransactionClient,
  productId: bigint,
  urls: string[],
  now: Date,
): Promise<void> {
  if (urls.length > MAX_IMAGES) {
    throw new BadRequestException(`附图最多 ${MAX_IMAGES} 张`);
  }
  await tx.productImage.deleteMany({ where: { productId } });
  if (urls.length === 0) {
    return;
  }
  await tx.productImage.createMany({
    data: urls.map((url, sortOrder) => ({
      productId,
      url,
      sortOrder,
      createdAt: now,
    })),
  });
}
