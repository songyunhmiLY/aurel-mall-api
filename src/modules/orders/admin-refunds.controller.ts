import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { ReviewRefundDto } from './dto/review-refund.dto';
import { RefundsService } from './refunds.service';

@Controller('admin/refunds')
@UseGuards(AdminJwtGuard)
export class AdminRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.refunds.listAdmin({
      status: status === undefined || status.trim() === '' ? undefined : status.trim(),
      userId:
        userId === undefined || userId.trim() === '' ? undefined : parseRouteId(userId.trim()),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id') id: string,
    @Body() body: ReviewRefundDto,
  ) {
    return this.refunds.approve(parseRouteId(id), admin.id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.refunds.reject(parseRouteId(id), admin.id);
  }
}
