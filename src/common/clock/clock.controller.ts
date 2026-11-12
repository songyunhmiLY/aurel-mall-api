import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { ClockService } from './clock.service';
import { SetClockOverrideDto } from './dto/set-clock-override.dto';

/** 覆盖接口只在 ALLOW_CLOCK_OVERRIDE=true 时生效。 */
@Controller('internal/clock')
export class ClockController {
  constructor(private readonly clock: ClockService) {}

  @Get()
  read() {
    return this.clock.readOverride();
  }

  @Put('override')
  set(@Body() body: SetClockOverrideDto) {
    return this.clock.setOverride(body.iso);
  }

  @Delete('override')
  clear() {
    return this.clock.clearOverride();
  }
}
