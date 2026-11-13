import { IsString, MaxLength, MinLength } from 'class-validator';

export class ShipOrderDto {
  @IsString()
  @MinLength(1, { message: '快递公司不正确' })
  @MaxLength(64, { message: '快递公司不正确' })
  courierName!: string;

  @IsString()
  @MinLength(1, { message: '运单号不正确' })
  @MaxLength(64, { message: '运单号不正确' })
  trackingNumber!: string;
}
