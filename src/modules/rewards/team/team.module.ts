import { Module } from '@nestjs/common';
import { AuthModule } from '../../../common/auth/auth.module';
import { ClockModule } from '../../../common/clock/clock.module';
import { MarketPerformanceModule } from '../market-performance.module';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  imports: [AuthModule, ClockModule, MarketPerformanceModule],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
