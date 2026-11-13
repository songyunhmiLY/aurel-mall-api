import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { NOTIFY_EVENTS } from '../../../common/notify/notify-intent';
import { DELIVERY_MODES, NOTIFY_PAGE_MAX } from '../notifications.constants';

const SLOT_FIELDS = [
  'amount',
  'time',
  'orderNo',
  'status',
  'pointsAmount',
  'withdrawableAmount',
  'payoutAmount',
  'bizType',
] as const;

export class NotifySlotDto {
  @IsIn(['wechat', 'sms'], { message: '模板空位不正确' })
  channel!: 'wechat' | 'sms';

  @IsString({ message: '模板空位不正确' })
  @MaxLength(32, { message: '模板空位不正确' })
  slot!: string;

  @IsIn(SLOT_FIELDS, { message: '模板空位对应的业务数据不正确' })
  field!: string;
}

export class UpdateSmsSettingsDto {
  @IsOptional()
  @IsString({ message: '短信 SecretId 不正确' })
  @MaxLength(128, { message: '短信 SecretId 不正确' })
  secretId?: string;

  @IsOptional()
  @IsString({ message: '短信密钥不正确' })
  @MaxLength(128, { message: '短信密钥不正确' })
  secretKey?: string;

  @IsOptional()
  @IsString({ message: '短信应用 ID 不正确' })
  @MaxLength(20, { message: '短信应用 ID 不正确' })
  sdkAppId?: string;

  @IsOptional()
  @IsString({ message: '短信签名不正确' })
  @MaxLength(64, { message: '短信签名不正确' })
  signName?: string;

  @IsOptional()
  @IsString({ message: '短信地域不正确' })
  @MaxLength(32, { message: '短信地域不正确' })
  region?: string | null;
}

export class UpdateNotifyEventDto {
  @IsIn(NOTIFY_EVENTS, { message: '事件不正确' })
  event!: string;

  @IsOptional()
  @IsBoolean({ message: '事件开关不正确' })
  enabled?: boolean;

  @IsOptional()
  @IsString({ message: '微信模板 ID 不正确' })
  @MaxLength(64, { message: '微信模板 ID 不正确' })
  wechatTemplateId?: string | null;

  @IsOptional()
  @IsString({ message: '短信模板 ID 不正确' })
  @MaxLength(20, { message: '短信模板 ID 不正确' })
  smsTemplateId?: string | null;

  @IsOptional()
  @IsString({ message: '跳转页面不正确' })
  @MaxLength(NOTIFY_PAGE_MAX, { message: '跳转页面不正确' })
  pagePath?: string | null;

  @IsOptional()
  @IsArray({ message: '模板空位不正确' })
  @ArrayMaxSize(20, { message: '模板空位不正确' })
  @ValidateNested({ each: true })
  @Type(() => NotifySlotDto)
  slots?: NotifySlotDto[];
}

export class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsIn(DELIVERY_MODES, { message: '推送方式不正确' })
  deliveryMode?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSmsSettingsDto)
  sms?: UpdateSmsSettingsDto;

  @IsOptional()
  @IsArray({ message: '事件不正确' })
  @ValidateNested({ each: true })
  @Type(() => UpdateNotifyEventDto)
  events?: UpdateNotifyEventDto[];
}
