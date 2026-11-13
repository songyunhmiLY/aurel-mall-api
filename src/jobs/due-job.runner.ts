import { Injectable } from '@nestjs/common';
import { CofounderDividendService } from '../modules/cofounder/cofounder-dividend.service';
import { FilingService } from '../modules/rewards/filing/filing.service';
import { PositionsService } from '../modules/rewards/positions/positions.service';
import { RedPacketService } from '../modules/rewards/red-packet/red-packet.service';

/**
 * 到点要做的事。是否到点由各自服务读取 ClockService，不看机器本地钟。
 * 红包结算跟报单检查用同一个启动时读入的钟点，结算的是前一个上海自然日。
 * 联合创始人定期分配用管理端配置的周期和钟点，不是这个锁定钟点。
 */
@Injectable()
export class DueJobRunner {
  constructor(
    private readonly filing: FilingService,
    private readonly positions: PositionsService,
    private readonly redPackets: RedPacketService,
    private readonly cofounders: CofounderDividendService,
  ) {}

  async runDue(): Promise<void> {
    await this.filing.runDue();
    await this.positions.runDue();
    await this.redPackets.runDue();
    await this.cofounders.runDue();
  }
}
