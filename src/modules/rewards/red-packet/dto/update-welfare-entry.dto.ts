import { IsOptional, IsString, MaxLength } from 'class-validator';
import { WELFARE_ENTRY_COPY_MAX, WELFARE_ENTRY_IMAGE_MAX } from '../red-packet.constants';

export class UpdateWelfareEntryDto {
  @IsString()
  @MaxLength(WELFARE_ENTRY_COPY_MAX, { message: '入口文案过长' })
  copy!: string;

  @IsOptional()
  @IsString()
  @MaxLength(WELFARE_ENTRY_IMAGE_MAX, { message: '入口图片地址过长' })
  imageUrl?: string | null;
}
