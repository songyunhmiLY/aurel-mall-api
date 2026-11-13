import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { PositionsModule } from '../rewards/positions/positions.module';
import { OpsOverviewController } from './ops-overview.controller';
import { OpsOverviewService } from './ops-overview.service';

@Module({
  imports: [AuthModule, ClockModule, PositionsModule],
  controllers: [OpsOverviewController],
  providers: [OpsOverviewService],
})
export class OpsModule {}
