import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { WalletAdminService } from './wallet-admin.service';

@Controller('admin')
@UseGuards(AdminJwtGuard)
export class WalletAdminController {
  constructor(private readonly wallets: WalletAdminService) {}

  @Get('users/:id/wallets')
  balances(@Param('id') id: string) {
    return this.wallets.balances(parseRouteId(id));
  }

  @Get('users/:id/wallet-holds')
  holds(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.wallets.holds(
      parseRouteId(id),
      status?.trim(),
      parsePage(page),
      parsePageSize(pageSize),
    );
  }

  @Get('users/:id/wallets/:walletType/ledger')
  ledger(
    @Param('id') id: string,
    @Param('walletType') walletType: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.wallets.ledger(
      parseRouteId(id),
      walletType,
      parsePage(page),
      parsePageSize(pageSize),
    );
  }

  @Get('transfers')
  transfers(
    @Query('payerId') payerId?: string,
    @Query('payeeId') payeeId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.wallets.transfers({
      payerId: parseOptionalId(payerId),
      payeeId: parseOptionalId(payeeId),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }
}

function parseOptionalId(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return parseRouteId(raw.trim());
}
