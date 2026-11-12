import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { AdminUsersService } from './admin-users.service';

@Controller('admin/users')
@UseGuards(AdminJwtGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(
    @Query('id') id?: string,
    @Query('nickname') nickname?: string,
    @Query('phone') phone?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.users.list({
      id: id === undefined || id.trim() === '' ? undefined : parseRouteId(id.trim()),
      nickname: nickname?.trim() || undefined,
      phone: phone?.trim() || undefined,
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.users.get(parseRouteId(id));
  }

  @Get(':id/kyc')
  kyc(@Param('id') id: string) {
    return this.users.getKyc(parseRouteId(id));
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string) {
    return this.users.disable(parseRouteId(id));
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string) {
    return this.users.enable(parseRouteId(id));
  }
}
