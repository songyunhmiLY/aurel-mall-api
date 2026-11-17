import { IsBoolean, IsInt, Max, Min } from 'class-validator';

export class SetSortDto {
  @IsInt({ message: '排序必须是整数' })
  @Min(-1_000_000, { message: '排序不正确' })
  @Max(1_000_000, { message: '排序不正确' })
  sortOrder!: number;
}

export class SetHomeVisibleDto {
  @IsBoolean({ message: '首页展示只能是 true 或 false' })
  homeVisible!: boolean;
}
