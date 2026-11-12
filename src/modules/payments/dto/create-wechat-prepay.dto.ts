import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateWechatPrepayDto {
  @Matches(/^[1-9]\d{0,18}$/, { message: '订单 ID 无效' })
  orderId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  openid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(127)
  description?: string;
}
