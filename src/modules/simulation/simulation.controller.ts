import { Body, Controller, Delete, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { ClockService } from '../../common/clock/clock.service';
import { SetClockOverrideDto } from '../../common/clock/dto/set-clock-override.dto';
import {
  AdvanceSimulationDto,
  RegisterUsersDto,
  RedPacketSignupDto,
  SimulatePurchaseDto,
  SimulateRoleDto,
} from './dto/simulation-actions.dto';
import { StepSimulationDto } from './dto/step-simulation.dto';
import { SimulationService } from './simulation.service';

/**
 * 时间仿真台。只在非正式环境可用：SIMULATION_ENABLED=false 时每个动作都会 403。
 * 造数走真实下单与支付，因此会产生真实订单、报单、入座与分红，可在管理端其他页面查看。
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

  @Get('overview')
  overview() {
    return this.simulation.overview();
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
  @HttpCode(200)
  step(@Body() body: StepSimulationDto) {
    return this.simulation.step(body);
  }

  /** 逐业务日推进：跨日公排、跨月核算按各自的业务日执行。 */
  @Post('advance')
  @HttpCode(200)
  advance(@Body() body: AdvanceSimulationDto) {
    return this.simulation.advance({ to: body.to });
  }

  @Post('register')
  @HttpCode(200)
  register(@Body() body: RegisterUsersDto) {
    return this.simulation.registerBatch(body);
  }

  @Post('purchase')
  @HttpCode(200)
  purchase(@Body() body: SimulatePurchaseDto) {
    return this.simulation.purchaseBatch(body);
  }

  /** 红包报名演示：userIds 为空时对全部在籍会员报名，报名时间取当前仿真时刻。 */
  @Post('red-packet-signup')
  @HttpCode(200)
  redPacketSignup(@Body() body: RedPacketSignupDto) {
    return this.simulation.redPacketSignup(body);
  }

  @Post('role')
  @HttpCode(200)
  role(@CurrentAdmin() admin: AdminPrincipal, @Body() body: SimulateRoleDto) {
    return this.simulation.enrollRole({
      userId: body.userId,
      role: body.role,
      adminId: admin.id,
    });
  }

  /** 只清时间轴，不动业务数据。 */
  @Post('reset')
  @HttpCode(200)
  reset() {
    return this.simulation.reset();
  }

  /** 清空业务数据：订单、钱包、树、报单、分红、角色，保留商品与系统配置。 */
  @Post('reset-data')
  @HttpCode(200)
  resetData() {
    return this.simulation.resetData();
  }
}
