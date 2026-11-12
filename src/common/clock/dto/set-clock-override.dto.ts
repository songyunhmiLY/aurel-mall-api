import { IsISO8601 } from 'class-validator';

export class SetClockOverrideDto {
  @IsISO8601({}, { message: 'iso 必须是 ISO-8601 时间' })
  iso!: string;
}
