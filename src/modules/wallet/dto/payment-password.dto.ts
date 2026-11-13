import { IsString, Matches } from 'class-validator';

export class SetPaymentPasswordDto {
  @IsString()
  @Matches(/^\S{6,64}$/, { message: '支付密码格式不正确' })
  password!: string;
}
