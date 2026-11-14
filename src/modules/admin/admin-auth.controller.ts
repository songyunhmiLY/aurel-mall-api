import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /** 登录每分钟最多 10 次，防止撞库。 */
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  login(@Body() body: AdminLoginDto) {
    return this.auth.login(body.username, body.password);
  }
}
