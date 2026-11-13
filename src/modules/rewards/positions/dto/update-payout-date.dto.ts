import { Matches } from 'class-validator';

export class UpdatePayoutDateDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '发放日不正确' })
  payoutDate!: string;
}
