import { Module } from '@nestjs/common';
import { AuthModule } from '../../../common/auth/auth.module';
import { ClockModule } from '../../../common/clock/clock.module';
import { AwardCreditModule } from '../award-credit.module';
import { MessagesModule } from '../../messages/messages.module';
import { FilingAdminController } from './filing-admin.controller';
import { FilingQueryService } from './filing-query.service';
import { FilingService } from './filing.service';

@Module({
  imports: [AuthModule, ClockModule, AwardCreditModule, MessagesModule],
  controllers: [FilingAdminController],
  providers: [FilingService, FilingQueryService],
  exports: [FilingService, FilingQueryService],
})
export class FilingModule {}
