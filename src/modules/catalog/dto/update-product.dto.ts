import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const MAX_INT = 2_147_483_647;

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  subtitle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  body?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverUrl?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  freightFen?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  priceFen?: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  pvFen?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_INT)
  costFen?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^\d+$/, { message: '分类编号不正确' })
  categoryId?: string | null;

  @IsOptional()
  @IsIn(['draft', 'on', 'off'], { message: '商品状态不正确' })
  status?: 'draft' | 'on' | 'off';

  /** 商城混排顺序，管理端配置。数值小的排前面；同值按创建时间倒序。 */
  @IsOptional()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  sortOrder?: number;

  /** 是否出现在小程序首页商品流。 */
  @IsOptional()
  @IsBoolean()
  homeVisible?: boolean;
}
