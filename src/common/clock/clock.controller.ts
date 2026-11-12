import { Body, Controller, Delete, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { extractClockCaller } from './clock-access';
import { ClockService } from './clock.service';
import { SetClockOverrideDto } from './dto/set-clock-override.dto';

@Controller('internal/clock')
export class ClockController {
  constructor(private readonly clock: ClockService) {}

  @Get()
  read(@Req() req: Request) {
    return this.clock.readOverride(extractClockCaller(req));
  }

  @Put('override')
  set(@Req() req: Request, @Body() body: SetClockOverrideDto) {
    return this.clock.setOverride(body.iso, extractClockCaller(req));
  }

  @Delete('override')
  clear(@Req() req: Request) {
    return this.clock.clearOverride(extractClockCaller(req));
  }
}
