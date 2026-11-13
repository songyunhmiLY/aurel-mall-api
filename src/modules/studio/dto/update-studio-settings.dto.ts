import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_EXTERNAL_NAME_MAX } from '../studio.constants';

/**
 * 只接受对外名称。补贴比例和报单钟点是启动时锁定的，不能从这里写入。
 */
export class UpdateStudioSettingsDto {
  @IsString()
  @MinLength(1, { message: '名称不正确' })
  @MaxLength(STUDIO_EXTERNAL_NAME_MAX, { message: '名称不正确' })
  externalName!: string;
}
