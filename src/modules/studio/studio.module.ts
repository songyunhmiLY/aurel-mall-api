import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { AwardCreditModule } from '../rewards/award-credit.module';
import { StudioPeopleController, StudioConfigController } from './studio-admin.controller';
import { StudioEnrollmentService } from './studio-enrollment.service';
import { StudioSettingsService } from './studio-settings.service';
import { StudioSubsidyService } from './studio-subsidy.service';

@Module({
  imports: [AuthModule, ClockModule, AwardCreditModule],
  controllers: [StudioPeopleController, StudioConfigController],
  providers: [StudioEnrollmentService, StudioSettingsService, StudioSubsidyService],
  exports: [StudioEnrollmentService, StudioSettingsService, StudioSubsidyService],
})
export class StudioModule {}
