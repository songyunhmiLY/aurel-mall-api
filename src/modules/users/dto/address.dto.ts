import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

export class AddressDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  contactName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  contactPhone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  province!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  city!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  district!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  detail!: string;

  @IsBoolean()
  isDefault!: boolean;
}
