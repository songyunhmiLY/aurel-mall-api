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
import { AdminJwtGuard } from '../../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../../common/auth/admin-principal';
import { CurrentAdmin } from '../../../common/auth/current-admin.decorator';
import { parsePage, parsePageSize, parseRouteId } from '../../../common/http/parse-id';
import { isShanghaiBizMonth } from '../../../common/clock/shanghai-calendar';
import { ExcludeMemberDto } from './dto/exclude-member.dto';
import { ManualPaymentDto } from './dto/manual-payment.dto';
import { UpdatePayoutDateDto } from './dto/update-payout-date.dto';
import { PositionsService } from './positions.service';

@Controller('admin/position-dividends')
@UseGuards(AdminJwtGuard)
export class PositionsAdminController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  preview(@Query('month') month?: string) {
    return this.positions.preview(parseMonth(month));
  }

  @Get('qualifications/:userId')
  qualification(@Param('userId') userId: string, @Query('month') month?: string) {
    return this.positions.qualification(parseRouteId(userId), parseMonth(month));
  }

  @Put(':month/payout-date')
  changePayoutDate(@Param('month') month: string, @Body() body: UpdatePayoutDateDto) {
    return this.positions.changePayoutDate(requireMonth(month), body.payoutDate);
  }

  @Post(':month/exclusions')
  @HttpCode(200)
  exclude(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('month') month: string,
    @Body() body: ExcludeMemberDto,
  ) {
    return this.positions.exclude(requireMonth(month), parseRouteId(body.userId), admin.id);
  }

  @Post(':month/manual-payments')
  @HttpCode(200)
  payManually(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('month') month: string,
    @Body() body: ManualPaymentDto,
  ) {
    return this.positions.payManually(
      requireMonth(month),
      {
        userId: parseRouteId(body.userId),
        positionCode: body.positionCode,
        actualAmountFen: BigInt(body.actualAmountFen),
        remark: body.remark,
      },
      admin.id,
    );
  }

  @Get(':month/records')
  records(
    @Param('month') month: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.positions.listRecords(
      requireMonth(month),
      parsePage(page),
      parsePageSize(pageSize),
    );
  }
}

function parseMonth(month: string | undefined): string | undefined {
  if (month === undefined || month.trim() === '') {
    return undefined;
  }
  return requireMonth(month);
}

function requireMonth(month: string): string {
  const value = month.trim();
  if (!isShanghaiBizMonth(value)) {
    throw new BadRequestException('月份不正确');
  }
  return value;
}
