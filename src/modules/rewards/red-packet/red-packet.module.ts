import { Module } from '@nestjs/common';
import { AuthModule } from '../../../common/auth/auth.module';
import { ClockModule } from '../../../common/clock/clock.module';
import { AwardCreditModule } from '../award-credit.module';
import { WelfareAdminController } from './red-packet-admin.controller';
import { RedPacketAdminService } from './red-packet-admin.service';
import { WelfareController } from './red-packet.controller';
import { RedPacketService } from './red-packet.service';

@Module({
  imports: [AuthModule, ClockModule, AwardCreditModule],
  controllers: [WelfareController, WelfareAdminController],
  providers: [RedPacketService, RedPacketAdminService],
  exports: [RedPacketService],
})
export class RedPacketModule {}
