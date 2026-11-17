import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { parseShanghaiDayRange } from '../../common/http/day-range';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { WithdrawalService } from './withdrawal.service';

@Controller('admin/withdrawals')
@UseGuards(AdminJwtGuard)
export class WithdrawalAdminController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const range = parseShanghaiDayRange(from, to);
    return this.withdrawals.listAdmin({
      status: status === undefined || status.trim() === '' ? undefined : status.trim(),
      userId:
        userId === undefined || userId.trim() === '' ? undefined : parseRouteId(userId.trim()),
      appliedFrom: range.from,
      appliedUntil: range.until,
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.withdrawals.getAdmin(parseRouteId(id));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.withdrawals.reject(parseRouteId(id), admin.id);
  }

  @Post(':id/payout')
  @HttpCode(200)
  payout(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.withdrawals.payout(parseRouteId(id), admin.id);
  }
}
