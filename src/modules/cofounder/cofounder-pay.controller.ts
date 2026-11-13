import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { CofounderPayService } from './cofounder-pay.service';

@Controller('me/cofounder')
@UseGuards(MiniProgramTokenGuard)
export class CofounderPayController {
  constructor(private readonly pay: CofounderPayService) {}

  @Post('activations')
  @HttpCode(200)
  start(@CurrentUser() user: UserPrincipal) {
    return this.pay.start(user.id);
  }
}
