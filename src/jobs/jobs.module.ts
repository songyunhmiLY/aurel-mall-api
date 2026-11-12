import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { AppEnv } from '../config/app-env';
import { toBullMqConnection } from '../config/redis-url';
import { APP_ENV } from '../config/tokens';
import { PLACEHOLDER_QUEUE } from './jobs.constants';
import { PlaceholderProcessor } from './placeholder.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => ({
        connection: toBullMqConnection(env.redisUrl),
      }),
    }),
    BullModule.registerQueue({ name: PLACEHOLDER_QUEUE }),
  ],
  providers: [PlaceholderProcessor],
})
export class JobsModule {}
