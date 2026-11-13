import { Module } from '@nestjs/common';
import { AuthModule } from '../../../common/auth/auth.module';
import { ClockModule } from '../../../common/clock/clock.module';
import { SettingsModule } from '../../settings/settings.module';
import { AwardCreditModule } from '../award-credit.module';
import { MarketPerformanceModule } from '../market-performance.module';
import { PositionsAdminController } from './positions-admin.controller';
import { PositionsService } from './positions.service';

@Module({
  imports: [AuthModule, ClockModule, SettingsModule, AwardCreditModule, MarketPerformanceModule],
  controllers: [PositionsAdminController],
  providers: [PositionsService],
  exports: [PositionsService],
})
export class PositionsModule {}
