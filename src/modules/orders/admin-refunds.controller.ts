import { Controller, Get, GoneException, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { RefundsService } from './refunds.service';

/**
 * 管理端退款接口。审核动作已下线（410 Gone），只保留只读列表用于历史追溯。
 * 页面不在菜单里，需要用直链访问；列表保留是为了财务能查历史退款记录。
 */
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
  approve(): never {
    throw refundReviewOffline();
  }

  @Post(':id/reject')
  reject(): never {
    throw refundReviewOffline();
  }
}

function refundReviewOffline(): GoneException {
  return new GoneException('退款审核已下线，历史记录仅可查看');
}
