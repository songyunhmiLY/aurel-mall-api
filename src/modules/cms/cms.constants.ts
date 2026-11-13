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
export const ARTICLE_BODY_MAX = 20_000;
export const SORT_MIN = -1_000_000;
export const SORT_MAX = 1_000_000;
