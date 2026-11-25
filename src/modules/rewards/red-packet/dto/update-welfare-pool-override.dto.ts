import { IsString, Matches } from 'class-validator';

export class UpdateWelfarePoolOverrideDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '日期不正确' })
  bizDate!: string;

  /** 十进制分字符串，非负整数。 */
  @IsString()
  @Matches(/^\d{1,12}$/, { message: '金额不正确' })
  amountFen!: string;
}
