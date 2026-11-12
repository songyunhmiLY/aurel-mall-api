import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { ClockController } from './clock.controller';
import { RedisClockOverrideStore } from './clock-override.store';
import { ClockService } from './clock.service';

@Module({
  imports: [RedisModule],
  controllers: [ClockController],
  providers: [RedisClockOverrideStore, ClockService],
  exports: [ClockService],
})
export class ClockModule {}
