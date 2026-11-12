import { IsIn } from 'class-validator';

export class ShelfProductDto {
  @IsIn(['on', 'off'], { message: '上下架状态只能是 on 或 off' })
  status!: 'on' | 'off';
}
