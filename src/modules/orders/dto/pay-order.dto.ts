import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PayOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  openid?: string;
}
