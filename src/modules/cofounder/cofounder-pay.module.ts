import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { PaymentsModule } from '../payments/payments.module';
import { CofounderPayController } from './cofounder-pay.controller';
import { CofounderPayService } from './cofounder-pay.service';
import { CofounderModule } from './cofounder.module';

@Module({
  imports: [AuthModule, ClockModule, CofounderModule, forwardRef(() => PaymentsModule)],
  controllers: [CofounderPayController],
  providers: [CofounderPayService],
  exports: [CofounderPayService],
})
export class CofounderPayModule {}
