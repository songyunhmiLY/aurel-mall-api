import { Module } from '@nestjs/common';
import { AdminJwtGuard } from './admin-jwt.guard';
import { MiniProgramTokenGuard } from './mini-program-token.guard';

/**
 * 认证占位。
 * 用户唯一登录键（手机号 vs 微信 openid）尚未确认，不要在这里发明登录规则。
 * 管理端预留 JWT，小程序预留 session/token。
 */
@Module({
  providers: [AdminJwtGuard, MiniProgramTokenGuard],
  exports: [AdminJwtGuard, MiniProgramTokenGuard],
})
export class AuthModule {}
