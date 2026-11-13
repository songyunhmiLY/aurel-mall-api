import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { PaymentsModule } from '../payments/payments.module';
import { TreesModule } from '../rewards/trees/trees.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminOrdersController } from './admin-orders.controller';
import { OrderPaymentSettler } from './order-payment.settler';
import { PendingSettlementHook } from './order-paid.hook';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [AuthModule, ClockModule, WalletModule, TreesModule, forwardRef(() => PaymentsModule)],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, OrderPaymentSettler, PendingSettlementHook],
  exports: [OrdersService, OrderPaymentSettler, PendingSettlementHook],
})
export class OrdersModule {}
