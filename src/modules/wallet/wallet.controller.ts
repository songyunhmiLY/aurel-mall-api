import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { parsePage, parsePageSize } from '../../common/http/parse-id';
import { DisplayNameService } from './display-name.service';
import { WalletService } from './wallet.service';

@Controller('me/wallets')
@UseGuards(MiniProgramTokenGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly categories: DisplayNameService,
  ) {}

  @Get()
  balances(@CurrentUser() user: UserPrincipal) {
    return this.wallet.getBalances(user.id);
  }

  @Get('withdrawable/categories')
  categoriesOf(@CurrentUser() user: UserPrincipal) {
    return this.categories.categoriesForUser(user.id);
  }

  @Get('withdrawable/categories/ledger')
  categoryLedger(
    @CurrentUser() user: UserPrincipal,
    @Query('displayName') displayName?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.categories.categoryLedger(
      user.id,
      displayName ?? '',
      parsePage(page),
      parsePageSize(pageSize),
    );
  }

  @Get(':walletType/ledger')
  ledger(
    @CurrentUser() user: UserPrincipal,
    @Param('walletType') walletType: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.wallet.listLedger(user.id, walletType, parsePage(page), parsePageSize(pageSize));
  }
}
