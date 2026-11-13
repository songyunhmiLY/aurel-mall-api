import { Injectable } from '@nestjs/common';
import { PaymentSettlementService } from '../rewards/payment-settlement.service';
import { PendingSettlementHook, type OrderPaidEvent } from './order-paid.hook';

@Injectable()
export class PaymentSettlementHook extends PendingSettlementHook {
  constructor(private readonly settlement: PaymentSettlementService) {
    super();
  }

  override afterOrderPaid(event: OrderPaidEvent): Promise<void> {
    return this.settlement.afterOrderPaid(event);
  }
}
