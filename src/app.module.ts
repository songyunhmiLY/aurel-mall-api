import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock/clock.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AppConfigModule } from './config/app-config.module';
import { JobsModule } from './jobs/jobs.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CofounderPayModule } from './modules/cofounder/cofounder-pay.module';
import { CofounderModule } from './modules/cofounder/cofounder.module';
import { OpsTeamModule } from './modules/ops-team/ops-team.module';
import { StudioModule } from './modules/studio/studio.module';
import { CmsModule } from './modules/cms/cms.module';
import { HealthModule } from './modules/health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { OpsModule } from './modules/ops/ops.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    ClockModule,
    JobsModule,
    HealthModule,
    UsersModule,
    CatalogModule,
    OrdersModule,
    OpsModule,
    PaymentsModule,
    AdminModule,
    WalletModule,
    CmsModule,
    RewardsModule,
    SettingsModule,
    CofounderModule,
    CofounderPayModule,
    StudioModule,
    OpsTeamModule,
  ],
})
export class AppModule {}
