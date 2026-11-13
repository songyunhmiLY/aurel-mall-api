import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import {
  COFOUNDER_ENTRY_COPY_MAX,
  COFOUNDER_IMAGE_COUNT_MAX,
  COFOUNDER_IMAGE_MAX,
  COFOUNDER_INTRO_BODY_MAX,
  COFOUNDER_INTRO_TITLE_MAX,
} from '../cofounder.constants';

export class UpdateCofounderContentDto {
  @IsString()
  @MaxLength(COFOUNDER_ENTRY_COPY_MAX, { message: '入口文案过长' })
  entryCopy!: string;

  @IsArray({ message: '入口图片不正确' })
  @ArrayMaxSize(COFOUNDER_IMAGE_COUNT_MAX, { message: '图片数量过多' })
  @IsString({ each: true, message: '图片地址不正确' })
  @MaxLength(COFOUNDER_IMAGE_MAX, { each: true, message: '图片地址不正确' })
  entryImageUrls!: string[];

  @IsString()
  @MaxLength(COFOUNDER_INTRO_TITLE_MAX, { message: '介绍标题过长' })
  introTitle!: string;

  @IsString()
  @MaxLength(COFOUNDER_INTRO_BODY_MAX, { message: '介绍正文过长' })
  introBody!: string;

  @IsArray({ message: '介绍图片不正确' })
  @ArrayMaxSize(COFOUNDER_IMAGE_COUNT_MAX, { message: '图片数量过多' })
  @IsString({ each: true, message: '图片地址不正确' })
  @MaxLength(COFOUNDER_IMAGE_MAX, { each: true, message: '图片地址不正确' })
  introImageUrls!: string[];
}
