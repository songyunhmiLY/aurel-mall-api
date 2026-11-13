import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from '../order.constants';

export class CreateOrderItemDto {
  @Matches(/^[1-9]\d{0,18}$/, { message: '商品不正确' })
  productId!: string;

  @IsInt({ message: '数量不正确' })
  @Min(1, { message: '数量不正确' })
  @Max(MAX_LINE_QUANTITY, { message: '数量不正确' })
  quantity!: number;
}

export class CreateOrderDto {
  @IsIn(['startup', 'mall'], { message: '专区不正确' })
  zone!: 'startup' | 'mall';

  @Matches(/^[1-9]\d{0,18}$/, { message: '地址不正确' })
  addressId!: string;

  @IsArray({ message: '请选择商品' })
  @ArrayMinSize(1, { message: '请选择商品' })
  @ArrayMaxSize(MAX_ORDER_LINES, { message: '请选择商品' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];
}
