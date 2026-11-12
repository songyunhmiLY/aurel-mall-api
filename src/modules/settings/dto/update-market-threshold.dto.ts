import { Matches } from 'class-validator';

export class UpdateMarketThresholdDto {
  @Matches(/^\d+$/, { message: '门槛 T 必须是非负整数字符串' })
  value!: string;
}
