import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import {
  ARTICLE_BODY_MAX,
  ARTICLE_STATUSES,
  ARTICLE_SUMMARY_MAX,
  ARTICLE_TITLE_MAX,
  CMS_KINDS,
  IMAGE_URL_MAX,
} from '../cms.constants';

export class CreateArticleDto {
  @IsIn(CMS_KINDS, { message: '内容类型不正确' })
  kind!: (typeof CMS_KINDS)[number];

  @IsString({ message: '标题不正确' })
  @MinLength(1, { message: '标题不正确' })
  @MaxLength(ARTICLE_TITLE_MAX, { message: '标题不正确' })
  title!: string;

  @IsString({ message: '摘要不正确' })
  @MinLength(1, { message: '摘要不正确' })
  @MaxLength(ARTICLE_SUMMARY_MAX, { message: '摘要不正确' })
  summary!: string;

  @IsString({ message: '正文不正确' })
  @MinLength(1, { message: '正文不正确' })
  @MaxLength(ARTICLE_BODY_MAX, { message: '正文不正确' })
  body!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: '封面不正确' })
  @MaxLength(IMAGE_URL_MAX, { message: '封面不正确' })
  coverUrl?: string | null;

  @IsOptional()
  @IsIn(ARTICLE_STATUSES, { message: '状态不正确' })
  status?: (typeof ARTICLE_STATUSES)[number];
}

export class UpdateArticleDto {
  @IsOptional()
  @IsIn(CMS_KINDS, { message: '内容类型不正确' })
  kind?: (typeof CMS_KINDS)[number];

  @IsOptional()
  @IsString({ message: '标题不正确' })
  @MinLength(1, { message: '标题不正确' })
  @MaxLength(ARTICLE_TITLE_MAX, { message: '标题不正确' })
  title?: string;

  @IsOptional()
  @IsString({ message: '摘要不正确' })
  @MinLength(1, { message: '摘要不正确' })
  @MaxLength(ARTICLE_SUMMARY_MAX, { message: '摘要不正确' })
  summary?: string;

  @IsOptional()
  @IsString({ message: '正文不正确' })
  @MinLength(1, { message: '正文不正确' })
  @MaxLength(ARTICLE_BODY_MAX, { message: '正文不正确' })
  body?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: '封面不正确' })
  @MaxLength(IMAGE_URL_MAX, { message: '封面不正确' })
  coverUrl?: string | null;
}

export class ArticleStatusDto {
  @IsIn(ARTICLE_STATUSES, { message: '状态不正确' })
  status!: (typeof ARTICLE_STATUSES)[number];
}
