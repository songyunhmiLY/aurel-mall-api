import { Matches } from 'class-validator';

export class SandboxSucceedDto {
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'payNo 无效' })
  payNo!: string;
}
