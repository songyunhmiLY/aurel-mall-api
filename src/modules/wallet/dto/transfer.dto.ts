import { IsString, Matches } from 'class-validator';

export class LookupTransferDto {
  @Matches(/^[1-9]\d{0,18}$/, { message: '编号不正确' })
  payeeId!: string;
}

export class CreateTransferDto {
  @Matches(/^[1-9]\d{0,18}$/, { message: '编号不正确' })
  payeeId!: string;

  @Matches(/^[1-9]\d{0,18}$/, { message: '金额不正确' })
  amountFen!: string;

  @IsString()
  @Matches(/^\S{6,64}$/, { message: '支付密码格式不正确' })
  paymentPassword!: string;
}
