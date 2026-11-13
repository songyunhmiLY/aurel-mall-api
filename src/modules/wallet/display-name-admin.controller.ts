import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { DisplayNameService } from './display-name.service';
import { UpdateDisplayNamesDto } from './dto/update-display-names.dto';

@Controller('admin/settings/withdrawal-display-names')
@UseGuards(AdminJwtGuard)
export class DisplayNameAdminController {
  constructor(private readonly names: DisplayNameService) {}

  @Get()
  list() {
    return this.names.listSources();
  }

  @Put()
  update(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateDisplayNamesDto) {
    return this.names.updateSources(body.items, admin.id);
  }
}
