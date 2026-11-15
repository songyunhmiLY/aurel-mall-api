import { Injectable } from '@nestjs/common';
import { CofounderDividendService } from '../modules/cofounder/cofounder-dividend.service';
import { OrderTimeoutService } from '../modules/orders/order-timeout.service';
import { SettlementCompensationService } from '../modules/orders/settlement-compensation.service';
import { FilingService } from '../modules/rewards/filing/filing.service';
import { PositionsService } from '../modules/rewards/positions/positions.service';
import { RedPacketService } from '../modules/rewards/red-packet/red-packet.service';

/**
 * 到点要做的事。是否到点由各自服务读取 ClockService，不看机器本地钟。
 * 红包结算跟报单检查用同一个启动时读入的钟点，结算的是前一个上海自然日。
 * 联合创始人定期分配用管理端配置的周期和钟点，不是这个锁定钟点。
 * 结算补偿每次 tick 都扫一遍，重试间隔由补偿记录自身的 last_tried_at 控制。
 */
@Injectable()
export class DueJobRunner {
  constructor(
    private readonly filing: FilingService,
    private readonly positions: PositionsService,
    private readonly redPackets: RedPacketService,
    private readonly cofounders: CofounderDividendService,
    private readonly compensations: SettlementCompensationService,
    private readonly orderTimeouts: OrderTimeoutService,
  ) {}

  async runDue(): Promise<void> {
    await this.filing.runDue();
    await this.positions.runDue();
    await this.redPackets.runDue();
    await this.cofounders.runDue();
    await this.compensations.runDue();
    // 超时关单放最后：先让补偿有机会结算，结算成功的订单就不再是待支付了。
    await this.orderTimeouts.closeExpired();
  }
}
