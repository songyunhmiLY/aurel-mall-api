import { IsString, Matches } from 'class-validator';

export class PreviewLoginDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,64}$/, { message: '预览身份标识不正确' })
  subject!: string;
}
