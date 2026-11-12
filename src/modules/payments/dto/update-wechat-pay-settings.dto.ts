import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateWechatPaySettingsDto {
  @IsOptional()
  @Matches(/^\d{1,32}$/, { message: '商户号必须是 1 到 32 位数字' })
  merchantId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  apiCertificate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\S{32}$/, { message: 'APIv3 密钥必须是 32 位且不能包含空白' })
  apiV3Key?: string;
}
