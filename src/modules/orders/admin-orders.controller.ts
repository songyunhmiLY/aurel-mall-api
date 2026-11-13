import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { ShipOrderDto } from './dto/ship-order.dto';
import { OrdersService } from './orders.service';

@Controller('admin/orders')
@UseGuards(AdminJwtGuard)
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(
    @Query('zone') zone?: string,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.orders.listAdmin({
      zone: zone === undefined || zone.trim() === '' ? undefined : zone.trim(),
      status: status === undefined || status.trim() === '' ? undefined : status.trim(),
      userId:
        userId === undefined || userId.trim() === '' ? undefined : parseRouteId(userId.trim()),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.orders.getAdmin(parseRouteId(id));
  }

  @Post(':id/ship')
  @HttpCode(200)
  ship(@Param('id') id: string, @Body() body: ShipOrderDto) {
    return this.orders.ship(parseRouteId(id), body);
  }
}
