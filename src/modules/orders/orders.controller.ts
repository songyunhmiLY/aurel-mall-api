import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { CreateOrderDto } from './dto/create-order.dto';
import { PayOrderDto } from './dto/pay-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(MiniProgramTokenGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(
    @CurrentUser() user: UserPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.orders.listForUser(user.id, parsePage(page), parsePageSize(pageSize));
  }

  @Get(':id')
  detail(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.orders.getForUser(user.id, parseRouteId(id));
  }

  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: UserPrincipal, @Body() body: CreateOrderDto) {
    return this.orders.create(user.id, {
      zone: body.zone,
      addressId: parseRouteId(body.addressId),
      items: body.items.map((item) => ({
        productId: parseRouteId(item.productId),
        quantity: item.quantity,
      })),
    });
  }

  @Post(':id/pay')
  @HttpCode(200)
  pay(@CurrentUser() user: UserPrincipal, @Param('id') id: string, @Body() body: PayOrderDto) {
    return this.orders.pay(user.id, parseRouteId(id), body ?? {});
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.orders.cancel(user.id, parseRouteId(id));
  }

  @Post(':id/timeout')
  @HttpCode(200)
  timeout(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.orders.timeout(user.id, parseRouteId(id));
  }
}
