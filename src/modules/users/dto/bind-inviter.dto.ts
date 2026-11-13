import { IsString, Matches } from 'class-validator';

export class BindInviterDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: '邀请码不正确' })
  inviteCode!: string;
}
