import { Module } from '@nestjs/common';
import { RedPacketService } from './red-packet.service';

@Module({
  providers: [RedPacketService],
  exports: [RedPacketService],
})
export class RedPacketModule {}
