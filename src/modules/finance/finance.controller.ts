import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize } from '../../common/http/parse-id';
import { CASH_INFLOW, CASH_OUTFLOW } from '../wallet/wallet.constants';
import { FinanceService } from './finance.service';

/** 财务对账只读接口。没有写入、没有导出。 */
@Controller('admin/finance')
@UseGuards(AdminJwtGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.finance.overview(from, to);
  }

  @Get('cash-ledger')
  cashLedger(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('direction') direction?: string,
    @Query('bizType') bizType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.finance.cashLedger({
      from,
      to,
      direction: normalizeDirection(direction),
      bizType: bizType?.trim() || undefined,
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('reconciliation')
  reconciliation(@Query('from') from?: string, @Query('to') to?: string) {
    return this.finance.reconciliation(from, to);
  }

  @Get('sku-sales')
  skuSales(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zone') zone?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.finance.skuSales({
      from,
      to,
      zone,
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }
}

function normalizeDirection(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed === CASH_INFLOW || trimmed === CASH_OUTFLOW ? trimmed : undefined;
}
