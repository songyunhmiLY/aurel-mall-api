import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { RefundsService } from './refunds.service';

@Controller()
@UseGuards(MiniProgramTokenGuard)
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('orders/:id/refunds')
  @HttpCode(200)
  apply(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.refunds.apply(user.id, parseRouteId(id));
  }

  @Get('me/refunds')
  list(
    @CurrentUser() user: UserPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.refunds.listForUser(user.id, parsePage(page), parsePageSize(pageSize));
  }

  @Get('me/refunds/:id')
  detail(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.refunds.getForUser(user.id, parseRouteId(id));
  }
}
