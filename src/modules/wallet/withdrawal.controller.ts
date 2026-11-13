import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { ApplyWithdrawalDto } from './dto/apply-withdrawal.dto';
import { WithdrawalService } from './withdrawal.service';

@Controller('me/withdrawals')
@UseGuards(MiniProgramTokenGuard)
export class WithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Get()
  list(
    @CurrentUser() user: UserPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.withdrawals.listForUser(user.id, parsePage(page), parsePageSize(pageSize));
  }

  @Get(':id')
  detail(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.withdrawals.getForUser(user.id, parseRouteId(id));
  }

  @Post()
  @HttpCode(200)
  apply(@CurrentUser() user: UserPrincipal, @Body() body: ApplyWithdrawalDto) {
    return this.withdrawals.apply(user.id, BigInt(body.amountFen));
  }
}
