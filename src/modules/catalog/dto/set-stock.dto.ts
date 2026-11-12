import { IsInt, Max, Min } from 'class-validator';

export class SetStockDto {
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  quantity!: number;
}
