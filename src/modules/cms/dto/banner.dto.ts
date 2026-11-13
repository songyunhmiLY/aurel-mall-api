import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  BANNER_STATUSES,
  BANNER_TITLE_MAX,
  IMAGE_URL_MAX,
  PAGE_PATH_MAX,
  SORT_MAX,
  SORT_MIN,
} from '../cms.constants';

export class CreateBannerDto {
  @IsString({ message: '标题不正确' })
  @MinLength(1, { message: '标题不正确' })
  @MaxLength(BANNER_TITLE_MAX, { message: '标题不正确' })
  title!: string;

  @IsString({ message: '图片地址不正确' })
  @MinLength(1, { message: '图片地址不正确' })
  @MaxLength(IMAGE_URL_MAX, { message: '图片地址不正确' })
  imageUrl!: string;

  @IsString({ message: '跳转页面不正确' })
  @MinLength(1, { message: '跳转页面不正确' })
  @MaxLength(PAGE_PATH_MAX, { message: '跳转页面不正确' })
  pagePath!: string;

  @IsOptional()
  @IsInt({ message: '排序不正确' })
  @Min(SORT_MIN, { message: '排序不正确' })
  @Max(SORT_MAX, { message: '排序不正确' })
  sortOrder?: number;

  @IsOptional()
  @IsIn(BANNER_STATUSES, { message: '状态不正确' })
  status?: (typeof BANNER_STATUSES)[number];
}

export class UpdateBannerDto {
  @IsOptional()
  @IsString({ message: '标题不正确' })
  @MinLength(1, { message: '标题不正确' })
  @MaxLength(BANNER_TITLE_MAX, { message: '标题不正确' })
  title?: string;

  @IsOptional()
  @IsString({ message: '图片地址不正确' })
  @MinLength(1, { message: '图片地址不正确' })
  @MaxLength(IMAGE_URL_MAX, { message: '图片地址不正确' })
  imageUrl?: string;

  @IsOptional()
  @IsString({ message: '跳转页面不正确' })
  @MinLength(1, { message: '跳转页面不正确' })
  @MaxLength(PAGE_PATH_MAX, { message: '跳转页面不正确' })
  pagePath?: string;

  @IsOptional()
  @IsInt({ message: '排序不正确' })
  @Min(SORT_MIN, { message: '排序不正确' })
  @Max(SORT_MAX, { message: '排序不正确' })
  sortOrder?: number;
}

export class BannerStatusDto {
  @IsIn(BANNER_STATUSES, { message: '状态不正确' })
  status!: (typeof BANNER_STATUSES)[number];
}
