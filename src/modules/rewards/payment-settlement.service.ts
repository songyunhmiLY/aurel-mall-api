import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { CofounderDividendService } from '../cofounder/cofounder-dividend.service';
import { AwardService } from './award.service';
import { FilingService } from './filing/filing.service';

type Tx = Prisma.TransactionClient;

/**
 * 支付成功事务里的报单和奖励。入座已经在调用前完成。
 * 重复调用不会重复入账：子单、当日报单和奖励业务号都有去重。
 */
@Injectable()
export class PaymentSettlementService {
  constructor(
    private readonly filing: FilingService,
    private readonly awards: AwardService,
    private readonly cofounders: CofounderDividendService,
  ) {}

  async afterOrderPaid(event: {
    tx: Tx;
    orderId: bigint;
    userId: bigint;
    zone: string;
    payAmountFen: number;
    pvFen: number;
    paidAt: Date;
  }): Promise<void> {
    const order = await event.tx.order.findUnique({ where: { id: event.orderId } });
    if (!order) {
      return;
    }
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      await this.filing.onStartupPaid(
        event.tx,
        { id: order.id, userId: order.userId, placedAt: order.placedAt },
        event.paidAt,
      );
    }
    await this.awards.grantForPaidOrder(
      event.tx,
      {
        id: order.id,
        userId: order.userId,
        zone: order.zone,
        goodsTotalFen: order.goodsTotalFen,
        pvFen: order.pvFen,
      },
      event.paidAt,
    );
    await this.cofounders.onPaidOrder(
      event.tx,
      {
        id: order.id,
        userId: order.userId,
        zone: order.zone,
        goodsTotalFen: order.goodsTotalFen,
        pvFen: order.pvFen,
      },
      event.paidAt,
    );
  }
}
