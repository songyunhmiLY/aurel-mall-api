import { Module } from '@nestjs/common';
import { FilingModule } from './filing/filing.module';
import { PositionsModule } from './positions/positions.module';
import { RedPacketModule } from './red-packet/red-packet.module';
import { RewardsService } from './rewards.service';
import { TreesModule } from './trees/trees.module';

@Module({
  imports: [TreesModule, FilingModule, PositionsModule, RedPacketModule],
  providers: [RewardsService],
  exports: [RewardsService, TreesModule, FilingModule, PositionsModule, RedPacketModule],
})
export class RewardsModule {}
