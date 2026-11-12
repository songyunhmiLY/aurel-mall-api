import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module';
import { AdminJwtGuard } from './admin-jwt.guard';
import { AdminTokenService } from './admin-token.service';
import { MiniProgramTokenGuard } from './mini-program-token.guard';

/**
 * 管理端登录已实现：单一管理员角色，账户之间权限相同。
 * 小程序登录键（手机号 vs 微信 openid）尚未确认，不要在这里发明用户登录规则。
 */
@Module({
  imports: [ClockModule],
  providers: [AdminJwtGuard, AdminTokenService, MiniProgramTokenGuard],
  exports: [AdminJwtGuard, AdminTokenService, MiniProgramTokenGuard],
})
export class AuthModule {}
