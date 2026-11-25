import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtGuard } from '../../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../../common/auth/admin-principal';
import { CurrentAdmin } from '../../../common/auth/current-admin.decorator';
import { isShanghaiBizDate } from '../../../common/clock/shanghai-calendar';
import { parsePage, parsePageSize, parseRouteId } from '../../../common/http/parse-id';
import { UpdateWelfareEntryDto } from './dto/update-welfare-entry.dto';
import { UpdateWelfarePoolOverrideDto } from './dto/update-welfare-pool-override.dto';
import { RedPacketAdminService } from './red-packet-admin.service';

@Controller('admin/welfare')
@UseGuards(AdminJwtGuard)
export class WelfareAdminController {
  constructor(private readonly welfare: RedPacketAdminService) {}

  @Get('entry')
  getEntry() {
    return this.welfare.getEntry();
  }

  @Put('entry')
  setEntry(@CurrentAdmin() admin: AdminPrincipal, @Body() body: UpdateWelfareEntryDto) {
    return this.welfare.setEntry(body, admin.id);
  }

  @Get('pool-overrides')
  poolOverrides() {
    return this.welfare.listPoolOverrides();
  }

  @Put('pool-overrides')
  setPoolOverride(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() body: UpdateWelfarePoolOverrideDto,
  ) {
    return this.welfare.setPoolOverride(body, admin.id);
  }

  @Delete('pool-overrides/:bizDate')
  deletePoolOverride(@Param('bizDate') bizDate?: string) {
    return this.welfare.deletePoolOverride(bizDate ?? '');
  }

  @Get('signups')
  signups(
    @Query('userId') userId?: string,
    @Query('bizDate') bizDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.welfare.listSignups({
      userId: parseOptionalId(userId),
      bizDate: parseBizDate(bizDate),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('participants')
  participants(
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.welfare.listParticipants({
      userId: parseOptionalId(userId),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }
}

function parseOptionalId(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return parseRouteId(raw.trim());
}

function parseBizDate(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (!isShanghaiBizDate(value)) {
    throw new BadRequestException('日期不正确');
  }
  return value;
}
