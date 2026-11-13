import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { wrapTransaction } from '../notify/notify-buffer';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super({ datasourceUrl: env.databaseUrl });
    const original = this.$transaction.bind(this) as (
      fn: unknown,
      options?: unknown,
    ) => Promise<unknown>;
    Object.assign(this, { $transaction: wrapTransaction(original) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
