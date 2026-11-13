import { Module } from '@nestjs/common';
import { AuthModule } from '../../../common/auth/auth.module';
import { MarketPerformanceModule } from '../market-performance.module';
import { NetworkAdminController } from './network-admin.controller';
import { NetworkAdminService } from './network-admin.service';

@Module({
  imports: [AuthModule, MarketPerformanceModule],
  controllers: [NetworkAdminController],
  providers: [NetworkAdminService],
  exports: [NetworkAdminService],
})
export class NetworkAdminModule {}
