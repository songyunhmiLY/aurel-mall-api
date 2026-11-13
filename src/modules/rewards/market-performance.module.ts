import { Module } from '@nestjs/common';
import { MarketPerformanceService } from './market-performance.service';

@Module({
  providers: [MarketPerformanceService],
  exports: [MarketPerformanceService],
})
export class MarketPerformanceModule {}
