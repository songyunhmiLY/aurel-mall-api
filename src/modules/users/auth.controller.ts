import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniLoginDto } from './dto/mini-login.dto';
import { MiniPhoneDto } from './dto/mini-phone.dto';
import { PreviewLoginDto } from './dto/preview-login.dto';
import { PreviewAuthEnabledGuard } from './preview-auth.guard';
import { UsersService } from './users.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly users: UsersService) {}

  @Post('mini/login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  miniLogin(@Body() body: MiniLoginDto) {
    return this.users.loginWithMiniProgram(body.code);
  }

  @Post('preview/login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseGuards(PreviewAuthEnabledGuard)
  previewLogin(@Body() body: PreviewLoginDto) {
    return this.users.loginPreview(body.subject);
  }

  @Post('mini/phone')
  @HttpCode(200)
  @UseGuards(MiniProgramTokenGuard)
  bindPhone(@CurrentUser() user: UserPrincipal, @Body() body: MiniPhoneDto) {
    return this.users.bindWechatPhone(user.id, body.code);
  }
}
