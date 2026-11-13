import { IsString, Matches } from 'class-validator';

export class BindInviterDto {
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,32}$/, { message: '邀请码不正确' })
  inviteCode!: string;
}
