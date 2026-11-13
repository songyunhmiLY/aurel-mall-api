import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../../common/http/parse-id';
import { isShanghaiBizDate } from '../../../common/clock/shanghai-calendar';
import { FilingQueryService } from './filing-query.service';

@Controller('admin')
@UseGuards(AdminJwtGuard)
export class FilingAdminController {
  constructor(private readonly filings: FilingQueryService) {}

  @Get('filings')
  list(
    @Query('userId') userId?: string,
    @Query('bizDate') bizDate?: string,
    @Query('sequence') sequence?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.filings.list({
      userId: parseOptionalId(userId),
      bizDate: parseBizDate(bizDate),
      sequence: parseSequence(sequence),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('filings/:id')
  detail(@Param('id') id: string) {
    return this.filings.get(parseRouteId(id));
  }

  @Get('filing-settlements')
  settlements(
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.filings.listSettlements({
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

function parseSequence(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException('序号不正确');
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestException('序号不正确');
  }
  return value;
}
