import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { UpdateWechatPaySettingsDto } from './dto/update-wechat-pay-settings.dto';
import { WechatPaySettingsService } from './wechat-pay-settings.service';

@Controller('admin/settings/wechat-pay')
@UseGuards(AdminJwtGuard)
export class WechatPaySettingsController {
  constructor(private readonly settings: WechatPaySettingsService) {}

  @Get()
  get() {
    return this.settings.getView();
  }

  @Put()
  update(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateWechatPaySettingsDto) {
    return this.settings.update(body, admin.id);
  }

  @Delete()
  clear() {
    return this.settings.clear();
  }
}
