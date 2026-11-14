import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { AppEnv } from '../config/app-env';
import { toBullMqConnection } from '../config/redis-url';
import { APP_ENV } from '../config/tokens';
import { CofounderModule } from '../modules/cofounder/cofounder.module';
import { OrdersModule } from '../modules/orders/orders.module';
import { FilingModule } from '../modules/rewards/filing/filing.module';
import { PositionsModule } from '../modules/rewards/positions/positions.module';
import { RedPacketModule } from '../modules/rewards/red-packet/red-packet.module';
import { DueJobProcessor } from './due-job.processor';
import { DueJobRunner } from './due-job.runner';
import { DueJobScheduler } from './due-job.scheduler';
import { DUE_QUEUE } from './jobs.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => ({
        connection: toBullMqConnection(env.redisUrl),
      }),
    }),
    BullModule.registerQueue({ name: DUE_QUEUE }),
    FilingModule,
    PositionsModule,
    RedPacketModule,
    CofounderModule,
    OrdersModule,
  ],
  providers: [DueJobRunner, DueJobProcessor, DueJobScheduler],
})
export class JobsModule {}
