import { IsString, MaxLength, MinLength } from 'class-validator';

export class SubmitKycDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  realName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(18)
  idNumber!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  mobile!: string;
}
