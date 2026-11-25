import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminJwtGuard } from '../src/common/auth/admin-jwt.guard';
import { MiniProgramTokenGuard } from '../src/common/auth/mini-program-token.guard';
import type { ClockService } from '../src/common/clock/clock.service';
import { toJsonSafe } from '../src/common/http/api-response';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { CMS_KIND_ARTICLE, CMS_KIND_NEWS, CMS_KIND_NOTICE } from '../src/modules/cms/cms.constants';
import { CmsService } from '../src/modules/cms/cms.service';
import { HomeAdminController } from '../src/modules/cms/home-admin.controller';
import { HomePublicController } from '../src/modules/cms/home-public.controller';
import { buildStage1 } from './support/stage1-harness';

const NOON = new Date('2026-11-13T04:00:00.000Z');
const LATER = new Date('2026-11-13T06:00:00.000Z');

function buildCms() {
  const stage = buildStage1();
  stage.clock.current = NOON;
  const cms = new CmsService(
    stage.db as unknown as PrismaService,
    stage.clock as unknown as ClockService,
  );
  return { ...stage, cms };
}

describe('homepage banners, tickers, and articles', () => {
  it('shows members only on banners and tickers, in sort order', async () => {
    const { cms } = buildCms();
    const hidden = await cms.createBanner({
      title: '草稿',
      imageUrl: 'https://cdn.example.com/draft.png',
      pagePath: 'pages/catalog/index',
      sortOrder: 0,
      status: 'draft',
    });
    const second = await cms.createBanner({
      title: '第二张',
      imageUrl: 'https://cdn.example.com/b.png',
      pagePath: '/pages/mall/index',
      sortOrder: 20,
      status: 'on',
    });
    const first = await cms.createBanner({
      title: '第一张',
      imageUrl: 'http://cdn.example.com/a.png',
      pagePath: 'pages/startup/index?from=home',
      sortOrder: 10,
      status: 'on',
    });

    const visible = await cms.listCurrentBanners();
    expect(visible.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(visible.items[0]).toEqual({
      id: first.id,
      title: '第一张',
      imageUrl: 'http://cdn.example.com/a.png',
      pagePath: 'pages/startup/index?from=home',
      sortOrder: 10,
    });
    expect(visible.items[0]).not.toHaveProperty('status');
    expect(toJsonSafe(visible.items[0])).toMatchObject({ id: first.id.toString() });

    const updated = await cms.updateBanner(first.id, {
      title: '已改',
      imageUrl: 'https://cdn.example.com/a2.png',
      pagePath: 'pages/article/detail',
      sortOrder: 30,
    });
    expect(updated).toMatchObject({
      title: '已改',
      imageUrl: 'https://cdn.example.com/a2.png',
      pagePath: 'pages/article/detail',
      sortOrder: 30,
      status: 'on',
      createdAt: NOON.toISOString(),
      updatedAt: NOON.toISOString(),
    });
    expect((await cms.listCurrentBanners()).items.map((item) => item.id)).toEqual([
      second.id,
      updated.id,
    ]);

    await cms.setBannerStatus(updated.id, 'off');
    expect((await cms.listCurrentBanners()).items.map((item) => item.id)).toEqual([second.id]);
    const takenDown = await cms.getAdminBanner(updated.id);
    expect(takenDown.status).toBe('off');
    expect(takenDown.id).toBe(updated.id);
    expect((await cms.listAdminBanners({ page: 1, pageSize: 20 })).total).toBe(3);
    expect(hidden.status).toBe('draft');

    const quiet = await cms.createTicker({ content: ' 未上架 ', sortOrder: 1 });
    expect(quiet.status).toBe('draft');
    expect(quiet.content).toBe('未上架');
    const laterText = await cms.createTicker({ content: '后一条', sortOrder: 2, status: 'on' });
    const earlierText = await cms.createTicker({ content: '先看这条', sortOrder: 1, status: 'on' });
    expect((await cms.listCurrentTickers()).items).toEqual([
      { id: earlierText.id, content: '先看这条', sortOrder: 1 },
      { id: laterText.id, content: '后一条', sortOrder: 2 },
    ]);
    await cms.updateTicker(earlierText.id, { content: '改过的字幕' });
    await cms.setTickerStatus(earlierText.id, 'off');
    expect(await cms.listCurrentTickers()).toEqual({
      items: [{ id: laterText.id, content: '后一条', sortOrder: 2 }],
    });
    expect((await cms.getAdminTicker(quiet.id)).status).toBe('draft');
  });

  it('publishes articles, news, and notices, and hides everything else', async () => {
    const { cms, clock } = buildCms();
    const draft = await cms.createArticle({
      kind: CMS_KIND_ARTICLE,
      title: '草稿文章',
      summary: '还没发',
      body: '正文',
    });
    expect(draft.status).toBe('draft');
    expect(draft.publishedAt).toBeNull();
    expect(draft.createdAt).toBe(NOON.toISOString());

    const news = await cms.createArticle({
      kind: CMS_KIND_NEWS,
      title: '平台新闻',
      summary: '摘要',
      body: '新闻正文',
      coverUrl: 'https://cdn.example.com/news.png',
      status: 'published',
    });
    clock.current = LATER;
    const notice = await cms.createArticle({
      kind: CMS_KIND_NOTICE,
      title: '系统通知',
      summary: '请知悉',
      body: '通知正文',
      coverUrl: '',
      status: 'published',
    });
    const article = await cms.setArticleStatus(
      (
        await cms.createArticle({
          kind: CMS_KIND_ARTICLE,
          title: '知识',
          summary: '一篇文章',
          body: '文章正文',
          coverUrl: null,
        })
      ).id,
      'published',
    );

    const listed = await cms.listCurrentArticles({ page: 1, pageSize: 20 });
    expect(listed.total).toBe(3);
    expect(listed.items.map((item) => item.kind)).toEqual([
      CMS_KIND_ARTICLE,
      CMS_KIND_NOTICE,
      CMS_KIND_NEWS,
    ]);
    expect(listed.items[0]).toEqual({
      id: article.id,
      kind: CMS_KIND_ARTICLE,
      title: '知识',
      summary: '一篇文章',
      coverUrl: null,
      publishedAt: LATER.toISOString(),
    });
    expect(listed.items[0]).not.toHaveProperty('body');
    expect(listed.items[0]).not.toHaveProperty('status');
    expect(toJsonSafe(listed.items[2])).toMatchObject({
      id: news.id.toString(),
      kind: CMS_KIND_NEWS,
      publishedAt: NOON.toISOString(),
    });

    const newsOnly = await cms.listCurrentArticles({
      kind: CMS_KIND_NEWS,
      page: 1,
      pageSize: 20,
    });
    expect(newsOnly.items.map((item) => item.id)).toEqual([news.id]);

    const detail = await cms.getCurrentArticle(notice.id);
    expect(detail).toEqual({
      id: notice.id,
      kind: CMS_KIND_NOTICE,
      title: '系统通知',
      summary: '请知悉',
      body: '通知正文',
      coverUrl: null,
      publishedAt: LATER.toISOString(),
    });

    await expect(cms.getCurrentArticle(draft.id)).rejects.toBeInstanceOf(NotFoundException);
    const edited = await cms.updateArticle(news.id, {
      title: '新闻修订',
      summary: '新摘要',
      body: '修订正文',
      coverUrl: 'https://cdn.example.com/news-2.png',
    });
    expect(edited.publishedAt).toBe(NOON.toISOString());
    expect(edited.updatedAt).toBe(LATER.toISOString());
    expect(edited.status).toBe('published');
    expect((await cms.getCurrentArticle(news.id)).body).toBe('修订正文');

    const removed = await cms.setArticleStatus(news.id, 'off');
    expect(removed.status).toBe('off');
    expect(removed.publishedAt).toBe(NOON.toISOString());
    await expect(cms.getCurrentArticle(news.id)).rejects.toThrow('内容不存在');
    expect((await cms.listCurrentArticles({ page: 1, pageSize: 20 })).total).toBe(2);

    clock.current = new Date('2026-11-14T01:00:00.000Z');
    const republished = await cms.setArticleStatus(news.id, 'published');
    expect(republished.publishedAt).toBe('2026-11-14T01:00:00.000Z');
    expect((await cms.listCurrentArticles({ page: 1, pageSize: 1 })).items[0]?.id).toBe(news.id);

    const adminNews = await cms.listAdminArticles({
      kind: CMS_KIND_NEWS,
      status: 'published',
      page: 1,
      pageSize: 20,
    });
    expect(adminNews.items.map((item) => item.id)).toEqual([news.id]);
    expect(adminNews.items[0]?.body).toBe('修订正文');
  });

  it('rejects a web address as a banner page and unknown article kinds', async () => {
    const { cms } = buildCms();
    await expect(
      cms.createBanner({
        title: '外链',
        imageUrl: 'https://cdn.example.com/a.png',
        pagePath: 'https://example.com/h5',
      }),
    ).rejects.toThrow('跳转页面必须是小程序页面');
    await expect(
      cms.createBanner({
        title: '坏图',
        imageUrl: 'not-a-url',
        pagePath: 'pages/home/index',
      }),
    ).rejects.toThrow('图片地址必须是 URL');
    await expect(cms.createTicker({ content: '   ', status: 'on' })).rejects.toThrow('字幕不正确');
    await expect(
      cms.createArticle({
        kind: 'help',
        title: '帮助',
        summary: '没有这个分类',
        body: '正文',
      }),
    ).rejects.toThrow('内容类型不正确');
    await expect(cms.getCurrentArticle(99n)).rejects.toThrow('内容不存在');
    await expect(cms.getAdminBanner(99n)).rejects.toThrow('轮播图不存在');
    await expect(cms.setTickerStatus(99n, 'off')).rejects.toThrow('滚动字幕不存在');
    await expect(cms.getAdminArticle(99n)).rejects.toThrow('资讯不存在');
    await expect(cms.listCurrentArticles({ kind: 'promo', page: 1, pageSize: 20 })).rejects.toThrow(
      '内容类型不正确',
    );
  });

  it('uses the existing login guards and does not add a membership check', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, HomePublicController)).toEqual([
      MiniProgramTokenGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, HomeAdminController)).toEqual([AdminJwtGuard]);
  });

  it('sanitizes the rich-text body but keeps images and plain formatting', async () => {
    const { cms } = buildCms();
    const raw =
      '<p style="text-align:center">图文正文</p>' +
      '<script>alert(1)</script>' +
      '<img src="https://img.example.com/a.png" alt="插图" onerror="alert(2)">' +
      '<a href="javascript:alert(3)" target="_blank">坏链接</a>' +
      '<a href="https://www.example.com">好链接</a>' +
      '<iframe src="https://evil.example.com"></iframe>';
    const saved = await cms.createArticle({
      kind: CMS_KIND_ARTICLE,
      title: '富文本',
      summary: '摘要',
      body: raw,
    });
    expect(saved.body).not.toContain('<script');
    expect(saved.body).not.toContain('onerror');
    expect(saved.body).not.toContain('javascript:');
    expect(saved.body).not.toContain('<iframe');
    expect(saved.body).toContain('<img src="https://img.example.com/a.png"');
    expect(saved.body).toContain('好链接');
    expect(saved.body).toContain('style="text-align:center"');

    // 更新同样净化，净化后为空会被拒绝。
    const edited = await cms.updateArticle(saved.id, {
      body: '<h2>新标题</h2><b>加粗</b>',
    });
    expect(edited.body).toBe('<h2>新标题</h2><b>加粗</b>');
    await expect(
      cms.updateArticle(saved.id, { body: '<script>alert(4)</script>' }),
    ).rejects.toThrow('正文不正确');
  });

  it('uploads rich-text images and stores raw bytes for the public reader', async () => {
    const { cms } = buildCms();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    await expect(cms.uploadImage({ mimetype: 'application/zip', size: 10, buffer: png })).rejects.toThrow(
      '只支持 png、jpg、gif、webp',
    );
    await expect(
      cms.uploadImage({ mimetype: 'image/png', size: 6 * 1024 * 1024, buffer: png }),
    ).rejects.toThrow('图片大小要在 5MB 以内');
    await expect(cms.uploadImage({ mimetype: 'image/png', size: 0, buffer: Buffer.alloc(0) })).rejects.toThrow(
      '图片大小要在 5MB 以内',
    );

    const saved = await cms.uploadImage({ mimetype: 'image/png', size: png.length, buffer: png });
    expect(saved.url).toMatch(/^\/api\/v1\/uploads\/\d+$/);
    const id = BigInt(saved.url.split('/').pop()!);
    const row = await cms.getImage(id);
    expect(row.mime).toBe('image/png');
    expect(row.sizeBytes).toBe(png.length);
    expect(Buffer.from(row.data).equals(png)).toBe(true);
    await expect(cms.getImage(999n)).rejects.toThrow('图片不存在');
  });
});
