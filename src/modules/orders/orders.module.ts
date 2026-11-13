import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { PaymentsModule } from '../payments/payments.module';
import { TreesModule } from '../rewards/trees/trees.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminRefundsController } from './admin-refunds.controller';
import { OrderPaymentSettler } from './order-payment.settler';
import { PendingSettlementHook } from './order-paid.hook';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [AuthModule, ClockModule, WalletModule, TreesModule, forwardRef(() => PaymentsModule)],
  controllers: [OrdersController, AdminOrdersController, RefundsController, AdminRefundsController],
  providers: [OrdersService, OrderPaymentSettler, PendingSettlementHook, RefundsService],
  exports: [OrdersService, OrderPaymentSettler, PendingSettlementHook, RefundsService],
})
export class OrdersModule {}
