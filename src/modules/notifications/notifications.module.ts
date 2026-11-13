import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { PrismaNotificationDirectory } from './notification-directory';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationSettingsController } from './notification-settings.controller';
import { NotificationSettingsService } from './notification-settings.service';
import { TencentSmsClient } from './tencent-sms.client';
import { WechatSubscribeClient } from './wechat-subscribe.client';

@Module({
  imports: [AuthModule, ClockModule],
  controllers: [NotificationSettingsController],
  providers: [
    NotificationSettingsService,
    PrismaNotificationDirectory,
    WechatSubscribeClient,
    TencentSmsClient,
    NotificationDispatchService,
  ],
})
export class NotificationsModule {}
