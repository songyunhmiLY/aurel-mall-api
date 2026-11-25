export const CMS_KIND_ARTICLE = 'article';
export const CMS_KIND_NEWS = 'news';
export const CMS_KIND_NOTICE = 'notice';

export const CMS_KINDS = [CMS_KIND_ARTICLE, CMS_KIND_NEWS, CMS_KIND_NOTICE] as const;

export const CMS_STATUS_DRAFT = 'draft';
export const CMS_STATUS_ON = 'on';
export const CMS_STATUS_PUBLISHED = 'published';
export const CMS_STATUS_OFF = 'off';

export const BANNER_STATUSES = [CMS_STATUS_DRAFT, CMS_STATUS_ON, CMS_STATUS_OFF] as const;
export const TICKER_STATUSES = BANNER_STATUSES;
export const ARTICLE_STATUSES = [CMS_STATUS_DRAFT, CMS_STATUS_PUBLISHED, CMS_STATUS_OFF] as const;

export const BANNER_TITLE_MAX = 128;
export const IMAGE_URL_MAX = 512;
export const PAGE_PATH_MAX = 512;
export const TICKER_CONTENT_MAX = 255;
export const ARTICLE_TITLE_MAX = 200;
export const ARTICLE_SUMMARY_MAX = 500;
/** 正文是富文本 HTML，标记本身占字符，放宽到 6 万。 */
export const ARTICLE_BODY_MAX = 60_000;
/** 正文里允许出现的图片/链接协议。 */
export const ARTICLE_ALLOWED_SCHEMES = ['http', 'https'] as const;
/** 编辑器图片上传单张上限（字节）。 */
export const CMS_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CMS_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const SORT_MIN = -1_000_000;
export const SORT_MAX = 1_000_000;
