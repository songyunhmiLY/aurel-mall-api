import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { AwardCreditModule } from '../rewards/award-credit.module';
import { OpsTeamAdminController } from './ops-team-admin.controller';
import { OpsTeamDividendService } from './ops-team-dividend.service';
import { OpsTeamEnrollmentService } from './ops-team-enrollment.service';

@Module({
  imports: [AuthModule, ClockModule, AwardCreditModule],
  controllers: [OpsTeamAdminController],
  providers: [OpsTeamEnrollmentService, OpsTeamDividendService],
  exports: [OpsTeamEnrollmentService, OpsTeamDividendService],
})
export class OpsTeamModule {}
