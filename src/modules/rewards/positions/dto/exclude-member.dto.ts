import { Matches } from 'class-validator';

export class ExcludeMemberDto {
  @Matches(/^\d+$/, { message: '会员不正确' })
  userId!: string;
}
