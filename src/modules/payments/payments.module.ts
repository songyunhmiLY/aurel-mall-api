import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { OrdersModule } from '../orders/orders.module';
import { WechatPaySettingsController } from './wechat-pay-settings.controller';
import { WechatPaySettingsService } from './wechat-pay-settings.service';
import { WechatPayController } from './wechat-pay.controller';
import { WechatPayGateway } from './wechat-pay.gateway';
import { WechatPayService } from './wechat-pay.service';

@Module({
  imports: [AuthModule, ClockModule, forwardRef(() => OrdersModule)],
  controllers: [WechatPayController, WechatPaySettingsController],
  providers: [WechatPayService, WechatPaySettingsService, WechatPayGateway],
  exports: [WechatPayService, WechatPayGateway, WechatPaySettingsService],
})
export class PaymentsModule {}
