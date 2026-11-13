import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { AppointStudioDto } from './dto/appoint-studio.dto';
import { UpdateStudioSettingsDto } from './dto/update-studio-settings.dto';
import { StudioEnrollmentService } from './studio-enrollment.service';
import { StudioSettingsService } from './studio-settings.service';
import { STUDIO_STATUS_ACTIVE, STUDIO_STATUS_CANCELLED } from './studio.constants';

@Controller('admin/studios')
@UseGuards(AdminJwtGuard)
export class StudioPeopleController {
  constructor(private readonly studios: StudioEnrollmentService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.studios.list({
      status: parseStatus(status),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Post()
  @HttpCode(200)
  appoint(@CurrentAdmin() admin: AdminPrincipal, @Body() body: AppointStudioDto) {
    return this.studios.appoint(parseRouteId(body.userId), admin.id);
  }

  @Post(':userId/cancel')
  @HttpCode(200)
  cancel(@CurrentAdmin() admin: AdminPrincipal, @Param('userId') userId: string) {
    return this.studios.cancel(parseRouteId(userId), admin.id);
  }
}

@Controller('admin/studio')
@UseGuards(AdminJwtGuard)
export class StudioConfigController {
  constructor(private readonly settings: StudioSettingsService) {}

  @Get('settings')
  async getSettings(): Promise<{ externalName: string }> {
    return { externalName: await this.settings.getExternalName() };
  }

  @Put('settings')
  updateSettings(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateStudioSettingsDto) {
    return this.settings.setExternalName(body.externalName, admin.id);
  }
}

function parseStatus(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (value !== STUDIO_STATUS_ACTIVE && value !== STUDIO_STATUS_CANCELLED) {
    throw new BadRequestException('状态不正确');
  }
  return value;
}
