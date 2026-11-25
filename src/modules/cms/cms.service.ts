import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Article, Banner, CmsImage, Prisma, Ticker } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ARTICLE_BODY_MAX,
  ARTICLE_STATUSES,
  ARTICLE_SUMMARY_MAX,
  ARTICLE_TITLE_MAX,
  BANNER_STATUSES,
  BANNER_TITLE_MAX,
  CMS_IMAGE_MAX_BYTES,
  CMS_IMAGE_MIMES,
  CMS_KINDS,
  CMS_STATUS_DRAFT,
  CMS_STATUS_ON,
  CMS_STATUS_PUBLISHED,
  IMAGE_URL_MAX,
  PAGE_PATH_MAX,
  SORT_MAX,
  SORT_MIN,
  TICKER_CONTENT_MAX,
  TICKER_STATUSES,
} from './cms.constants';
import { sanitizeRichText } from '../../common/text/rich-text';

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MemberBannerView {
  id: bigint;
  title: string;
  imageUrl: string;
  pagePath: string;
  sortOrder: number;
}

export interface AdminBannerView extends MemberBannerView {
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemberTickerView {
  id: bigint;
  content: string;
  sortOrder: number;
}

export interface AdminTickerView extends MemberTickerView {
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemberArticleListItem {
  id: bigint;
  kind: string;
  title: string;
  summary: string;
  coverUrl: string | null;
  publishedAt: string;
}

export interface MemberArticleView extends MemberArticleListItem {
  body: string;
}

export interface AdminArticleView {
  id: bigint;
  kind: string;
  title: string;
  summary: string;
  body: string;
  coverUrl: string | null;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminImageUploadView {
  /** 相对路径，前端负责拼成绝对地址后再写进正文。 */
  url: string;
}

export interface BannerWriteInput {
  title: string;
  imageUrl: string;
  pagePath: string;
  sortOrder?: number;
  status?: string;
}

export interface BannerUpdateInput {
  title?: string;
  imageUrl?: string;
  pagePath?: string;
  sortOrder?: number;
}

export interface TickerWriteInput {
  content: string;
  sortOrder?: number;
  status?: string;
}

export interface TickerUpdateInput {
  content?: string;
  sortOrder?: number;
}

export interface ArticleWriteInput {
  kind: string;
  title: string;
  summary: string;
  body: string;
  coverUrl?: string | null;
  status?: string;
}

export interface ArticleUpdateInput {
  kind?: string;
  title?: string;
  summary?: string;
  body?: string;
  coverUrl?: string | null;
}

/**
 * 首页轮播图、滚动字幕、资讯和知识。
 * 会员读接口只返回已上架或已发布的内容，不区分会员与非会员。
 * 下架把状态写成 off（资讯离开 published），不删除行。
 */
@Injectable()
export class CmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async listCurrentBanners(): Promise<{ items: MemberBannerView[] }> {
    const rows = await this.prisma.banner.findMany({
      where: { status: CMS_STATUS_ON },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.filter(hasPagePath).map(toMemberBanner) };
  }

  async listCurrentTickers(): Promise<{ items: MemberTickerView[] }> {
    const rows = await this.prisma.ticker.findMany({
      where: { status: CMS_STATUS_ON },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toMemberTicker) };
  }

  async listCurrentArticles(query: {
    kind?: string;
    page: number;
    pageSize: number;
  }): Promise<PageResult<MemberArticleListItem>> {
    const where: Prisma.ArticleWhereInput = { status: CMS_STATUS_PUBLISHED };
    if (query.kind !== undefined) {
      where.kind = parseKind(query.kind);
    }
    const [total, rows] = await Promise.all([
      this.prisma.article.count({ where }),
      this.prisma.article.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.flatMap((row) => {
        const item = toMemberArticleListItem(row);
        return item ? [item] : [];
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getCurrentArticle(id: bigint): Promise<MemberArticleView> {
    const row = await this.prisma.article.findUnique({ where: { id } });
    if (!row || row.status !== CMS_STATUS_PUBLISHED || row.publishedAt === null) {
      throw new NotFoundException('内容不存在');
    }
    return toMemberArticle(row);
  }

  async listAdminBanners(query: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<PageResult<AdminBannerView>> {
    const where: Prisma.BannerWhereInput = {};
    if (query.status !== undefined) {
      where.status = parseBannerStatus(query.status);
    }
    return this.pageBanners(where, query.page, query.pageSize);
  }

  async getAdminBanner(id: bigint): Promise<AdminBannerView> {
    return toAdminBanner(await this.requireBanner(id));
  }

  async createBanner(input: BannerWriteInput): Promise<AdminBannerView> {
    const now = await this.clock.now();
    const row = await this.prisma.banner.create({
      data: {
        title: requiredText(input.title, '标题', BANNER_TITLE_MAX),
        imageUrl: parseImageUrl(input.imageUrl, '图片地址'),
        linkUrl: parsePagePath(input.pagePath),
        sortOrder: input.sortOrder === undefined ? 0 : assertSort(input.sortOrder),
        status: input.status === undefined ? CMS_STATUS_DRAFT : parseBannerStatus(input.status),
        createdAt: now,
        updatedAt: now,
      },
    });
    return toAdminBanner(row);
  }

  async updateBanner(id: bigint, input: BannerUpdateInput): Promise<AdminBannerView> {
    const current = await this.requireBanner(id);
    const now = await this.clock.now();
    const row = await this.prisma.banner.update({
      where: { id },
      data: {
        title:
          input.title === undefined
            ? current.title
            : requiredText(input.title, '标题', BANNER_TITLE_MAX),
        imageUrl:
          input.imageUrl === undefined
            ? current.imageUrl
            : parseImageUrl(input.imageUrl, '图片地址'),
        linkUrl: input.pagePath === undefined ? current.linkUrl : parsePagePath(input.pagePath),
        sortOrder: input.sortOrder === undefined ? current.sortOrder : assertSort(input.sortOrder),
        updatedAt: now,
      },
    });
    return toAdminBanner(row);
  }

  async setBannerStatus(id: bigint, status: string): Promise<AdminBannerView> {
    await this.requireBanner(id);
    const now = await this.clock.now();
    const row = await this.prisma.banner.update({
      where: { id },
      data: { status: parseBannerStatus(status), updatedAt: now },
    });
    return toAdminBanner(row);
  }

  async listAdminTickers(query: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<PageResult<AdminTickerView>> {
    const where: Prisma.TickerWhereInput = {};
    if (query.status !== undefined) {
      where.status = parseTickerStatus(query.status);
    }
    const [total, rows] = await Promise.all([
      this.prisma.ticker.count({ where }),
      this.prisma.ticker.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map(toAdminTicker), total, page: query.page, pageSize: query.pageSize };
  }

  async getAdminTicker(id: bigint): Promise<AdminTickerView> {
    return toAdminTicker(await this.requireTicker(id));
  }

  async createTicker(input: TickerWriteInput): Promise<AdminTickerView> {
    const now = await this.clock.now();
    const row = await this.prisma.ticker.create({
      data: {
        content: requiredText(input.content, '字幕', TICKER_CONTENT_MAX),
        sortOrder: input.sortOrder === undefined ? 0 : assertSort(input.sortOrder),
        status: input.status === undefined ? CMS_STATUS_DRAFT : parseTickerStatus(input.status),
        createdAt: now,
        updatedAt: now,
      },
    });
    return toAdminTicker(row);
  }

  async updateTicker(id: bigint, input: TickerUpdateInput): Promise<AdminTickerView> {
    const current = await this.requireTicker(id);
    const now = await this.clock.now();
    const row = await this.prisma.ticker.update({
      where: { id },
      data: {
        content:
          input.content === undefined
            ? current.content
            : requiredText(input.content, '字幕', TICKER_CONTENT_MAX),
        sortOrder: input.sortOrder === undefined ? current.sortOrder : assertSort(input.sortOrder),
        updatedAt: now,
      },
    });
    return toAdminTicker(row);
  }

  async setTickerStatus(id: bigint, status: string): Promise<AdminTickerView> {
    await this.requireTicker(id);
    const now = await this.clock.now();
    const row = await this.prisma.ticker.update({
      where: { id },
      data: { status: parseTickerStatus(status), updatedAt: now },
    });
    return toAdminTicker(row);
  }

  async listAdminArticles(query: {
    kind?: string;
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<PageResult<AdminArticleView>> {
    const where: Prisma.ArticleWhereInput = {};
    if (query.kind !== undefined) {
      where.kind = parseKind(query.kind);
    }
    if (query.status !== undefined) {
      where.status = parseArticleStatus(query.status);
    }
    const [total, rows] = await Promise.all([
      this.prisma.article.count({ where }),
      this.prisma.article.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map(toAdminArticle), total, page: query.page, pageSize: query.pageSize };
  }

  async getAdminArticle(id: bigint): Promise<AdminArticleView> {
    return toAdminArticle(await this.requireArticle(id));
  }

  async createArticle(input: ArticleWriteInput): Promise<AdminArticleView> {
    const status = input.status === undefined ? CMS_STATUS_DRAFT : parseArticleStatus(input.status);
    const now = await this.clock.now();
    const row = await this.prisma.article.create({
      data: {
        kind: parseKind(input.kind),
        title: requiredText(input.title, '标题', ARTICLE_TITLE_MAX),
        summary: requiredText(input.summary, '摘要', ARTICLE_SUMMARY_MAX),
        body: requiredBody(input.body),
        coverUrl: optionalImageUrl(input.coverUrl, '封面'),
        status,
        publishedAt: status === CMS_STATUS_PUBLISHED ? now : null,
        createdAt: now,
        updatedAt: now,
      },
    });
    return toAdminArticle(row);
  }

  async updateArticle(id: bigint, input: ArticleUpdateInput): Promise<AdminArticleView> {
    const current = await this.requireArticle(id);
    const now = await this.clock.now();
    const row = await this.prisma.article.update({
      where: { id },
      data: {
        kind: input.kind === undefined ? current.kind : parseKind(input.kind),
        title:
          input.title === undefined
            ? current.title
            : requiredText(input.title, '标题', ARTICLE_TITLE_MAX),
        summary:
          input.summary === undefined
            ? current.summary
            : requiredText(input.summary, '摘要', ARTICLE_SUMMARY_MAX),
        body:
          input.body === undefined ? current.body : requiredBody(input.body),
        coverUrl:
          input.coverUrl === undefined
            ? current.coverUrl
            : optionalImageUrl(input.coverUrl, '封面'),
        updatedAt: now,
      },
    });
    return toAdminArticle(row);
  }

  async setArticleStatus(id: bigint, status: string): Promise<AdminArticleView> {
    const current = await this.requireArticle(id);
    const next = parseArticleStatus(status);
    const now = await this.clock.now();
    const publishing = next === CMS_STATUS_PUBLISHED && current.status !== CMS_STATUS_PUBLISHED;
    const row = await this.prisma.article.update({
      where: { id },
      data: {
        status: next,
        publishedAt: publishing ? now : current.publishedAt,
        updatedAt: now,
      },
    });
    return toAdminArticle(row);
  }

  /** 富文本插图上传：原图字节直接入库，返回相对地址由前端拼绝对 URL。 */
  async uploadImage(file: {
    mimetype: string;
    size: number;
    buffer: Buffer;
  }): Promise<AdminImageUploadView> {
    if (!file || !Buffer.isBuffer(file.buffer)) {
      throw new BadRequestException('请选择图片文件');
    }
    if (!(CMS_IMAGE_MIMES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException('只支持 png、jpg、gif、webp 图片');
    }
    if (file.size < 1 || file.size > CMS_IMAGE_MAX_BYTES) {
      throw new BadRequestException('图片大小要在 5MB 以内');
    }
    const now = await this.clock.now();
    const row = await this.prisma.cmsImage.create({
      data: {
        mime: file.mimetype,
        sizeBytes: file.size,
        data: new Uint8Array(file.buffer),
        createdAt: now,
      },
    });
    return { url: `/api/v1/uploads/${row.id}` };
  }

  /** 公开只读供图：富文本和封面里的图片不走登录。 */
  async getImage(id: bigint): Promise<CmsImage> {
    const row = await this.prisma.cmsImage.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('图片不存在');
    }
    return row;
  }

  private async pageBanners(
    where: Prisma.BannerWhereInput,
    page: number,
    pageSize: number,
  ): Promise<PageResult<AdminBannerView>> {
    const [total, rows] = await Promise.all([
      this.prisma.banner.count({ where }),
      this.prisma.banner.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toAdminBanner), total, page, pageSize };
  }

  private async requireBanner(id: bigint): Promise<Banner> {
    const row = await this.prisma.banner.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('轮播图不存在');
    }
    return row;
  }

  private async requireTicker(id: bigint): Promise<Ticker> {
    const row = await this.prisma.ticker.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('滚动字幕不存在');
    }
    return row;
  }

  private async requireArticle(id: bigint): Promise<Article> {
    const row = await this.prisma.article.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('资讯不存在');
    }
    return row;
  }
}

function hasPagePath(row: Banner): boolean {
  return row.linkUrl !== null && row.linkUrl.trim().length > 0;
}

function toMemberBanner(row: Banner): MemberBannerView {
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.imageUrl,
    pagePath: row.linkUrl ?? '',
    sortOrder: row.sortOrder,
  };
}

function toAdminBanner(row: Banner): AdminBannerView {
  return {
    ...toMemberBanner(row),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMemberTicker(row: Ticker): MemberTickerView {
  return { id: row.id, content: row.content, sortOrder: row.sortOrder };
}

function toAdminTicker(row: Ticker): AdminTickerView {
  return {
    ...toMemberTicker(row),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMemberArticleListItem(row: Article): MemberArticleListItem | null {
  if (row.publishedAt === null) {
    return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    coverUrl: row.coverUrl,
    publishedAt: row.publishedAt.toISOString(),
  };
}

function toMemberArticle(row: Article): MemberArticleView {
  const item = toMemberArticleListItem(row);
  if (!item) {
    throw new NotFoundException('内容不存在');
  }
  return { ...item, body: row.body };
}

function toAdminArticle(row: Article): AdminArticleView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    body: row.body,
    coverUrl: row.coverUrl,
    status: row.status,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseKind(kind: string): string {
  if (!(CMS_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException('内容类型不正确');
  }
  return kind;
}

function parseBannerStatus(status: string): string {
  if (!(BANNER_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException('状态不正确');
  }
  return status;
}

function parseTickerStatus(status: string): string {
  if (!(TICKER_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException('状态不正确');
  }
  return status;
}

function parseArticleStatus(status: string): string {
  if (!(ARTICLE_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException('状态不正确');
  }
  return status;
}

function requiredText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${label}不正确`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new BadRequestException(`${label}不正确`);
  }
  return trimmed;
}

/** 正文按富文本处理：先净化再校验长度，纯文本旧内容不受影响。 */
function requiredBody(value: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('正文不正确');
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) {
    throw new BadRequestException('正文不正确');
  }
  const safe = sanitizeRichText(trimmed).trim();
  if (safe.length < 1 || safe.length > ARTICLE_BODY_MAX) {
    throw new BadRequestException('正文不正确');
  }
  return safe;
}

function assertSort(value: number): number {
  if (!Number.isInteger(value) || value < SORT_MIN || value > SORT_MAX) {
    throw new BadRequestException('排序不正确');
  }
  return value;
}

function optionalImageUrl(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  return parseImageUrl(value, label);
}

function parseImageUrl(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${label}不正确`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > IMAGE_URL_MAX) {
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

function parsePagePath(value: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('跳转页面不正确');
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > PAGE_PATH_MAX || /\s/.test(trimmed)) {
    throw new BadRequestException('跳转页面不正确');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new BadRequestException('跳转页面必须是小程序页面');
  }
  return trimmed;
}
