import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { AwardCreditService } from './award-credit.service';

@Module({
  imports: [WalletModule],
  providers: [AwardCreditService],
  exports: [AwardCreditService],
})
export class AwardCreditModule {}
