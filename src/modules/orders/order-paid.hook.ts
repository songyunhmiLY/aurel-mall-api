import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * 支付成功、库存扣减、创业专区入座都提交之后调用。
 * 报单、奖励、团队业绩和消息推送不在本阶段实现，只留这个钩子。
 */
export interface OrderPaidEvent {
  tx: Prisma.TransactionClient;
  orderId: bigint;
  userId: bigint;
  zone: string;
  payAmountFen: number;
  pvFen: number;
  paidAt: Date;
}

export interface OrderPaidHook {
  afterOrderPaid(event: OrderPaidEvent): Promise<void>;
}

@Injectable()
export class PendingSettlementHook implements OrderPaidHook {
  afterOrderPaid(_event: OrderPaidEvent): Promise<void> {
    return Promise.resolve();
  }
}
