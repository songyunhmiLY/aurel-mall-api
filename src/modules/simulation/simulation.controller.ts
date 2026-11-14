import { Body, Controller, Delete, Get, Post, Put, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { ClockService } from '../../common/clock/clock.service';
import { SetClockOverrideDto } from '../../common/clock/dto/set-clock-override.dto';
import { StepSimulationDto } from './dto/step-simulation.dto';
import { SimulationService } from './simulation.service';

/**
 * 时间仿真台。查看状态与时间轴不受限；
 * 修改时钟与推进要求 ALLOW_CLOCK_OVERRIDE=true（服务内部再校验）。
 */
@UseGuards(AdminJwtGuard)
@Controller('admin/simulation')
export class SimulationController {
  constructor(
    private readonly simulation: SimulationService,
    private readonly clock: ClockService,
  ) {}

  @Get('status')
  status() {
    return this.simulation.status();
  }

  @Get('timeline')
  timeline() {
    return this.simulation.timeline();
  }

  @Put('clock')
  setClock(@Body() body: SetClockOverrideDto) {
    return this.simulation.setClock(body.iso);
  }

  @Delete('clock')
  clearClock() {
    return this.simulation.clearClock();
  }

  @Post('step')
  step(@Body() body: StepSimulationDto) {
    return this.simulation.step(body);
  }

  @Post('reset')
  reset() {
    return this.simulation.reset();
  }
}
