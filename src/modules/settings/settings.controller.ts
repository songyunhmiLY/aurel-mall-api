import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { UpdateMarketThresholdDto } from './dto/update-market-threshold.dto';
import { SettingsService } from './settings.service';

@Controller('admin/settings')
@UseGuards(AdminJwtGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('marketing-manager-market-threshold')
  getMarketThreshold() {
    return this.settings.getMarketingManagerMarketThreshold();
  }

  @Put('marketing-manager-market-threshold')
  updateMarketThreshold(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() body: UpdateMarketThresholdDto,
  ) {
    return this.settings.setMarketingManagerMarketThreshold(body.value, admin.id);
  }
}
