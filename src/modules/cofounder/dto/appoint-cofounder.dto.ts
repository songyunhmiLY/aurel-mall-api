import { Matches } from 'class-validator';

export class AppointCofounderDto {
  @Matches(/^[1-9]\d{0,18}$/, { message: '会员编号不正确' })
  userId!: string;
}
