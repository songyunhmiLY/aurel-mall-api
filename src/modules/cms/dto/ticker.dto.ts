import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { SORT_MAX, SORT_MIN, TICKER_CONTENT_MAX, TICKER_STATUSES } from '../cms.constants';

export class CreateTickerDto {
  @IsString({ message: '字幕不正确' })
  @MinLength(1, { message: '字幕不正确' })
  @MaxLength(TICKER_CONTENT_MAX, { message: '字幕不正确' })
  content!: string;

  @IsOptional()
  @IsInt({ message: '排序不正确' })
  @Min(SORT_MIN, { message: '排序不正确' })
  @Max(SORT_MAX, { message: '排序不正确' })
  sortOrder?: number;

  @IsOptional()
  @IsIn(TICKER_STATUSES, { message: '状态不正确' })
  status?: (typeof TICKER_STATUSES)[number];
}

export class UpdateTickerDto {
  @IsOptional()
  @IsString({ message: '字幕不正确' })
  @MinLength(1, { message: '字幕不正确' })
  @MaxLength(TICKER_CONTENT_MAX, { message: '字幕不正确' })
  content?: string;

  @IsOptional()
  @IsInt({ message: '排序不正确' })
  @Min(SORT_MIN, { message: '排序不正确' })
  @Max(SORT_MAX, { message: '排序不正确' })
  sortOrder?: number;
}

export class TickerStatusDto {
  @IsIn(TICKER_STATUSES, { message: '状态不正确' })
  status!: (typeof TICKER_STATUSES)[number];
}
