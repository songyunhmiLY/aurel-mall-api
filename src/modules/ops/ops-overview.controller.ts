import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { OpsOverviewService } from './ops-overview.service';

@Controller('admin/ops')
@UseGuards(AdminJwtGuard)
export class OpsOverviewController {
  constructor(private readonly overview: OpsOverviewService) {}

  @Get('overview')
  get(@Query('period') period?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.overview.get({ period, from, to });
  }
}
