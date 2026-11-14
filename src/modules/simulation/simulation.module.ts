import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { JobsModule } from '../../jobs/jobs.module';
import { SimulationController } from './simulation.controller';
import { RedisSimulationStore } from './simulation-store';
import { SIMULATION_STORE } from './simulation.types';
import { SimulationService } from './simulation.service';

@Module({
  imports: [ClockModule, JobsModule],
  controllers: [SimulationController],
  providers: [
    RedisSimulationStore,
    { provide: SIMULATION_STORE, useExisting: RedisSimulationStore },
    SimulationService,
  ],
})
export class SimulationModule {}
