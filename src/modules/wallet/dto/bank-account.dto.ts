import { IsString, MaxLength, MinLength } from 'class-validator';

export class SaveBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  accountName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  bankName!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(30)
  accountNo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  branchName!: string;
}
