import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [ClockModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
