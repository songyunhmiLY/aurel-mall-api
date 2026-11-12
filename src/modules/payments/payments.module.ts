import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { WechatPaySettingsController } from './wechat-pay-settings.controller';
import { WechatPaySettingsService } from './wechat-pay-settings.service';
import { WechatPayController } from './wechat-pay.controller';
import { WechatPayGateway } from './wechat-pay.gateway';
import { WechatPayService } from './wechat-pay.service';

@Module({
  imports: [AuthModule, ClockModule],
  controllers: [WechatPayController, WechatPaySettingsController],
  providers: [WechatPayService, WechatPaySettingsService, WechatPayGateway],
  exports: [WechatPayService],
})
export class PaymentsModule {}
