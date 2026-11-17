import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { FinanceModule } from './modules/finance/finance.module';
import { HealthModule } from './modules/health/health.module';
import { MessagesModule } from './modules/messages/messages.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { OpsModule } from './modules/ops/ops.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SimulationModule } from './modules/simulation/simulation.module';
import { UsersModule } from './modules/users/users.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    // 全局限流。登录、支付回调等敏感入口在各自的 controller 上用 @Throttle 收紧。
    // 单机内存计数，多实例部署时应换成 Redis 存储。
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
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
    FinanceModule,
    RewardsModule,
    SettingsModule,
    SimulationModule,
    CofounderModule,
    CofounderPayModule,
    StudioModule,
    OpsTeamModule,
    NotificationsModule,
    MessagesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
