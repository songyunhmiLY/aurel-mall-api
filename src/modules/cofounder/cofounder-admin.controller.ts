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
import { CofounderAdminService } from './cofounder-admin.service';
import { COFOUNDER_STATUS_ACTIVE, COFOUNDER_STATUS_CANCELLED } from './cofounder.constants';
import { AppointCofounderDto } from './dto/appoint-cofounder.dto';
import { UpdateCofounderContentDto } from './dto/update-cofounder-content.dto';
import { UpdateCofounderSettingsDto } from './dto/update-cofounder-settings.dto';

@Controller('admin/cofounders')
@UseGuards(AdminJwtGuard)
export class CofounderPeopleController {
  constructor(private readonly cofounders: CofounderAdminService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.cofounders.list({
      status: parseStatus(status),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Post()
  @HttpCode(200)
  appoint(@CurrentAdmin() admin: AdminPrincipal, @Body() body: AppointCofounderDto) {
    return this.cofounders.appoint(parseRouteId(body.userId), admin.id);
  }

  @Get(':userId/cancellation')
  cancellation(@Param('userId') userId: string) {
    return this.cofounders.cancellation(parseRouteId(userId));
  }

  @Post(':userId/cancel')
  @HttpCode(200)
  cancel(@CurrentAdmin() admin: AdminPrincipal, @Param('userId') userId: string) {
    return this.cofounders.cancel(parseRouteId(userId), admin.id);
  }
}

@Controller('admin/cofounder')
@UseGuards(AdminJwtGuard)
export class CofounderConfigController {
  constructor(private readonly cofounders: CofounderAdminService) {}

  @Get('settings')
  settings() {
    return this.cofounders.getSettings();
  }

  @Put('settings')
  updateSettings(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateCofounderSettingsDto) {
    return this.cofounders.updateSettings(
      {
        seatCap: body.seatCap,
        userButtonOpen: body.userButtonOpen,
        activationAmountFen: BigInt(body.activationAmountFen),
        payoutMode: body.payoutMode,
        schedule: body.schedule,
        poolThresholdFen: BigInt(body.poolThresholdFen),
        perPersonThresholdFen: BigInt(body.perPersonThresholdFen),
      },
      admin.id,
    );
  }

  @Get('content')
  content() {
    return this.cofounders.getContent();
  }

  @Put('content')
  updateContent(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateCofounderContentDto) {
    return this.cofounders.setContent(body, admin.id);
  }
}

function parseStatus(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (value !== COFOUNDER_STATUS_ACTIVE && value !== COFOUNDER_STATUS_CANCELLED) {
    throw new BadRequestException('状态不正确');
  }
  return value;
}
