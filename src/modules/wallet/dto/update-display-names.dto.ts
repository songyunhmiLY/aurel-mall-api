import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WITHDRAWAL_DISPLAY_SOURCES } from '../wallet.constants';

export class DisplayNameItemDto {
  @IsIn(WITHDRAWAL_DISPLAY_SOURCES, { message: '提现分类来源不正确' })
  sourceCode!: string;

  @IsString()
  @MinLength(1, { message: '显示名不正确' })
  @MaxLength(64, { message: '显示名不正确' })
  displayName!: string;
}

export class UpdateDisplayNamesDto {
  @IsArray({ message: '请填写显示名' })
  @ArrayMinSize(1, { message: '请填写显示名' })
  @ValidateNested({ each: true })
  @Type(() => DisplayNameItemDto)
  items!: DisplayNameItemDto[];
}
