import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.client = new Redis(env.redisUrl, { maxRetriesPerRequest: 2 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
