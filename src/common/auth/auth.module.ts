import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module';
import { AdminJwtGuard } from './admin-jwt.guard';
import { AdminTokenService } from './admin-token.service';
import { MiniProgramTokenGuard } from './mini-program-token.guard';
import { MiniProgramTokenService } from './mini-program-token.service';

/**
 * 管理端登录：单一管理员角色。
 * 用户登录：小程序用 wechat_mini 的 openid。手机号不是登录键。
 * wechat_oa、wechat_web、sms_phone 只预留，不在这里实现。
 */
@Module({
  imports: [ClockModule],
  providers: [AdminJwtGuard, AdminTokenService, MiniProgramTokenGuard, MiniProgramTokenService],
  exports: [AdminJwtGuard, AdminTokenService, MiniProgramTokenGuard, MiniProgramTokenService],
})
export class AuthModule {}
