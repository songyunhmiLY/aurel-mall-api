import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../../common/http/parse-id';
import { AwardAdminService } from './award-admin.service';

@Controller('admin/awards')
@UseGuards(AdminJwtGuard)
export class AwardAdminController {
  constructor(private readonly awards: AwardAdminService) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('orderId') orderId?: string,
    @Query('rewardType') rewardType?: string,
    @Query('layer') layer?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.awards.list({
      userId: parseOptionalId(userId),
      orderId: parseOptionalId(orderId),
      rewardType: blankToUndefined(rewardType),
      layer: parseLayer(layer),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }
}

function blankToUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw.trim();
}

function parseOptionalId(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return parseRouteId(raw.trim());
}

function parseLayer(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException('层数不正确');
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > 15) {
    throw new BadRequestException('层数不正确');
  }
  return value;
}
