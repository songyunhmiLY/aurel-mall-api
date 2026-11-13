import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PAYOUT_MODES, SCHEDULE_CYCLES } from '../cofounder.constants';

export class CofounderScheduleDto {
  @IsIn(SCHEDULE_CYCLES, { message: '发放周期不正确' })
  cycle!: 'daily' | 'weekly' | 'monthly' | 'interval';

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: '发放时刻不正确' })
  time!: string;

  @IsInt({ message: '每周发放日不正确' })
  @Min(1, { message: '每周发放日不正确' })
  @Max(7, { message: '每周发放日不正确' })
  weekday!: number;

  @IsInt({ message: '每月发放日不正确' })
  @Min(1, { message: '每月发放日不正确' })
  @Max(31, { message: '每月发放日不正确' })
  monthDay!: number;

  @IsInt({ message: '间隔天数不正确' })
  @Min(1, { message: '间隔天数不正确' })
  @Max(366, { message: '间隔天数不正确' })
  intervalDays!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '起始日期不正确' })
  anchorDate!: string;
}

export class UpdateCofounderSettingsDto {
  @IsInt({ message: '名额上限不正确' })
  @Min(0, { message: '名额上限不正确' })
  @Max(1_000_000, { message: '名额上限不正确' })
  seatCap!: number;

  @IsBoolean({ message: '按钮开关不正确' })
  userButtonOpen!: boolean;

  @IsString()
  @Matches(/^\d+$/, { message: '开通金额不正确' })
  activationAmountFen!: string;

  @IsIn(PAYOUT_MODES, { message: '分配方式不正确' })
  payoutMode!: 'immediate' | 'periodic' | 'pool_total' | 'per_person';

  @ValidateNested()
  @Type(() => CofounderScheduleDto)
  schedule!: CofounderScheduleDto;

  @IsString()
  @Matches(/^\d+$/, { message: '池子总额不正确' })
  poolThresholdFen!: string;

  @IsString()
  @Matches(/^\d+$/, { message: '人均额度不正确' })
  perPersonThresholdFen!: string;
}
