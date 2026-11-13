import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { WalletService } from './wallet.service';

@Controller('me/wallets')
@UseGuards(MiniProgramTokenGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  balances(@CurrentUser() user: UserPrincipal) {
    return this.wallet.getBalances(user.id);
  }
}
