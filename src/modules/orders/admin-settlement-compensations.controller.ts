import { Controller, Get, GoneException, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { SettlementCompensationService } from './settlement-compensation.service';

/**
 * 结算补偿的管理端接口。挂在资金分组下：
 * GET    /admin/finance/settlement-compensations          列表
 * POST   /admin/finance/settlement-compensations/:id/retry   继续结算
 * POST   /admin/finance/settlement-compensations/:id/refund  转退款（已下线，410）
 */
@Controller('admin/finance/settlement-compensations')
@UseGuards(AdminJwtGuard)
export class AdminSettlementCompensationsController {
  constructor(private readonly compensations: SettlementCompensationService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.compensations.list({
      status: status === undefined || status.trim() === '' ? undefined : status.trim(),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.compensations.retryOne(parseRouteId(id), { adminId: admin.id });
  }

  /**
   * 转退款已下线：商城与补偿都不再产生退款，补偿只能「继续结算」。
   * 路由保留是为了让旧版管理端拿到明确提示，而不是让人以为按钮坏了。
   */
  @Post(':id/refund')
  refund(): never {
    throw new GoneException('转退款已下线，请通过补货后继续结算处理');
  }
}
