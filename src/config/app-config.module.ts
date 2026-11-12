import { Global, Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { parseAppEnv, type AppEnv } from './app-env';
import type { LockedRuntimeConfig } from './locked-runtime';
import { APP_ENV, LOCKED_RUNTIME_CONFIG } from './tokens';

@Injectable()
export class LockedRuntimeConfigLogger implements OnModuleInit {
  private readonly logger = new Logger(LockedRuntimeConfigLogger.name);

  constructor(@Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig) {}

  onModuleInit(): void {
    this.logger.log(`locked runtime config loaded: ${JSON.stringify(this.locked)}`);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: APP_ENV,
      useFactory: (): AppEnv => parseAppEnv(process.env),
    },
    {
      provide: LOCKED_RUNTIME_CONFIG,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): LockedRuntimeConfig => env.locked,
    },
    LockedRuntimeConfigLogger,
  ],
  exports: [APP_ENV, LOCKED_RUNTIME_CONFIG],
})
export class AppConfigModule {}
