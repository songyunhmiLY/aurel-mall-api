import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [AuthModule, ClockModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
