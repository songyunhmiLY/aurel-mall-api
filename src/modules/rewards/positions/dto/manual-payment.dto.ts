import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ManualPaymentDto {
  @Matches(/^\d+$/, { message: '会员不正确' })
  userId!: string;

  @Matches(/^[a-z][a-z0-9_]{0,31}$/, { message: '职位不正确' })
  positionCode!: string;

  @Matches(/^\d+$/, { message: '金额不正确' })
  actualAmountFen!: string;

  @IsString()
  @MinLength(1, { message: '请填写备注' })
  @MaxLength(200, { message: '请填写备注' })
  remark!: string;
}
