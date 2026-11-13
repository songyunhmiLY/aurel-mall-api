import { Injectable } from '@nestjs/common';
import { FilingService } from '../modules/rewards/filing/filing.service';
import { PositionsService } from '../modules/rewards/positions/positions.service';

/**
 * 到点要做的事。是否到点由各自服务读取 ClockService，不看机器本地钟。
 */
@Injectable()
export class DueJobRunner {
  constructor(
    private readonly filing: FilingService,
    private readonly positions: PositionsService,
  ) {}

  async runDue(): Promise<void> {
    await this.filing.runDue();
    await this.positions.runDue();
  }
}
