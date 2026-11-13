import { Matches } from 'class-validator';

export class ApplyWithdrawalDto {
  @Matches(/^[1-9]\d{0,18}$/, { message: '金额不正确' })
  amountFen!: string;
}
