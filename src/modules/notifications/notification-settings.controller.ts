import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';
import { NotificationSettingsService } from './notification-settings.service';

@Controller('admin/settings/notifications')
@UseGuards(AdminJwtGuard)
export class NotificationSettingsController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get()
  get() {
    return this.settings.getView();
  }

  @Put()
  update(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateNotificationSettingsDto) {
    return this.settings.update(body, admin.id);
  }
}
