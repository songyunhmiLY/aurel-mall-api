import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parseShanghaiDayRange } from '../../common/http/day-range';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { ShipOrderDto } from './dto/ship-order.dto';
import { OrdersService } from './orders.service';
import { SettlementCompensationService } from './settlement-compensation.service';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import type { AdminPrincipal } from '../../common/auth/admin-principal';

@Controller('admin/orders')
@UseGuards(AdminJwtGuard)
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly compensations: SettlementCompensationService,
  ) {}

  @Get()
  list(
    @Query('zone') zone?: string,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const range = parseShanghaiDayRange(from, to);
    return this.orders.listAdmin({
      zone: zone === undefined || zone.trim() === '' ? undefined : zone.trim(),
      status: status === undefined || status.trim() === '' ? undefined : status.trim(),
      userId:
        userId === undefined || userId.trim() === '' ? undefined : parseRouteId(userId.trim()),
      placedFrom: range.from,
      placedUntil: range.until,
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.orders.getAdmin(parseRouteId(id));
  }

  /**
   * 人工强制完成结算：钱包冻结不够扣就扣到可扣尽的最低值（创业专区按单价对齐、
   * 零头留在账户），缺口写进订单备注；创业专区订单未入座的尝试入座，
   * 订单转已支付、补偿记录关闭。仅当订单存在活跃结算补偿（界面黄色「！」标记）时可用。
   */
  @Post(':id/force-settle')
  @HttpCode(200)
  forceSettle(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.compensations.forceComplete(parseRouteId(id), admin.id);
  }

  @Post(':id/ship')
  @HttpCode(200)
  ship(@Param('id') id: string, @Body() body: ShipOrderDto) {
    return this.orders.ship(parseRouteId(id), body);
  }
}
