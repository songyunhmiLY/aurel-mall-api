import { Module } from '@nestjs/common';
import { AwardAdminModule } from './admin/award-admin.module';
import { NetworkAdminModule } from './admin/network-admin.module';
import { AwardCreditModule } from './award-credit.module';
import { AwardService } from './award.service';
import { FilingModule } from './filing/filing.module';
import { MarketPerformanceModule } from './market-performance.module';
import { PaymentSettlementService } from './payment-settlement.service';
import { PositionsModule } from './positions/positions.module';
import { RedPacketModule } from './red-packet/red-packet.module';
import { RewardsService } from './rewards.service';
import { TeamModule } from './team/team.module';
import { TreesModule } from './trees/trees.module';

@Module({
  imports: [
    TreesModule,
    AwardCreditModule,
    FilingModule,
    MarketPerformanceModule,
    PositionsModule,
    TeamModule,
    NetworkAdminModule,
    AwardAdminModule,
    RedPacketModule,
  ],
  providers: [RewardsService, AwardService, PaymentSettlementService],
  exports: [
    RewardsService,
    TreesModule,
    FilingModule,
    PositionsModule,
    RedPacketModule,
    PaymentSettlementService,
    AwardService,
  ],
})
export class RewardsModule {}
