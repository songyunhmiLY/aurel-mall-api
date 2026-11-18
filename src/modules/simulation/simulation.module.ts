import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { JobsModule } from '../../jobs/jobs.module';
import { CofounderPayModule } from '../cofounder/cofounder-pay.module';
import { CofounderModule } from '../cofounder/cofounder.module';
import { OpsTeamModule } from '../ops-team/ops-team.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { StudioModule } from '../studio/studio.module';
import { UsersModule } from '../users/users.module';
import { SimulationController } from './simulation.controller';
import { RedisSimulationStore } from './simulation-store';
import { SIMULATION_STORE } from './simulation.types';
import { SimulationService } from './simulation.service';

/**
 * 仿真台依赖正式业务模块：造数走真实下单、支付、报单、入座与角色开通，
 * 不另写一套假逻辑。
 */
@Module({
  imports: [
    AuthModule,
    ClockModule,
    JobsModule,
    UsersModule,
    OrdersModule,
    PaymentsModule,
    CofounderModule,
    CofounderPayModule,
    StudioModule,
    OpsTeamModule,
  ],
  controllers: [SimulationController],
  providers: [
    RedisSimulationStore,
    { provide: SIMULATION_STORE, useExisting: RedisSimulationStore },
    SimulationService,
  ],
})
export class SimulationModule {}
