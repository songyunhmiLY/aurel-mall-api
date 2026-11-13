import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../../common/auth/user-principal';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { RedPacketAdminService } from './red-packet-admin.service';
import { RedPacketService } from './red-packet.service';

@Controller('me/welfare')
@UseGuards(MiniProgramTokenGuard)
export class WelfareController {
  constructor(
    private readonly redPackets: RedPacketService,
    private readonly admin: RedPacketAdminService,
  ) {}

  @Get()
  status(@CurrentUser() user: UserPrincipal) {
    return this.redPackets.statusFor(user.id);
  }

  @Get('entry')
  entry() {
    return this.admin.getEntry();
  }

  @Post('signups')
  signup(@CurrentUser() user: UserPrincipal) {
    return this.redPackets.signup(user.id);
  }
}
