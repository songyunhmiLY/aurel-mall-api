import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { BindInviterDto } from './dto/bind-inviter.dto';
import { UsersService } from './users.service';

@Controller('me')
@UseGuards(MiniProgramTokenGuard)
export class InviterController {
  constructor(private readonly users: UsersService) {}

  @Post('inviter')
  @HttpCode(200)
  bind(@CurrentUser() user: UserPrincipal, @Body() body: BindInviterDto) {
    return this.users.bindInviter(user.id, body.inviteCode);
  }
}
