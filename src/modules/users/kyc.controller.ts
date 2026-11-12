import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { KycService } from './kyc.service';

@Controller('me/kyc')
@UseGuards(MiniProgramTokenGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  getMine(@CurrentUser() user: UserPrincipal) {
    return this.kyc.getForUser(user.id);
  }

  @Post()
  @HttpCode(200)
  submit(@CurrentUser() user: UserPrincipal, @Body() body: SubmitKycDto) {
    return this.kyc.submit(user.id, body);
  }
}
