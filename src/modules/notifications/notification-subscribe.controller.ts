import { Controller, Get, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import { NotificationSettingsService } from './notification-settings.service';

/**
 * 小程序调用 wx.requestSubscribeMessage 之前，读取当前可以请求授权的微信模板。
 * 只要求登录，不检查会员身份。不是消息列表，也不是会员设置页。
 */
@Controller('notifications')
@UseGuards(MiniProgramTokenGuard)
export class NotificationSubscribeController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get('subscribe-templates')
  subscribeTemplates() {
    return this.settings.listSubscribeTemplates();
  }
}
