import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { AwardCreditModule } from '../rewards/award-credit.module';
import { WalletModule } from '../wallet/wallet.module';
import { CofounderActivationSettler } from './cofounder-activation.settler';
import { CofounderAdminService } from './cofounder-admin.service';
import { CofounderConfigController, CofounderPeopleController } from './cofounder-admin.controller';
import { CofounderController } from './cofounder.controller';
import { CofounderDividendService } from './cofounder-dividend.service';
import { CofounderEnrollmentService } from './cofounder-enrollment.service';
import { CofounderPoolService } from './cofounder-pool.service';
import { CofounderReviewService } from './cofounder-review.service';
import { CofounderSettingsService } from './cofounder-settings.service';

@Module({
  imports: [AuthModule, ClockModule, AwardCreditModule, WalletModule],
  controllers: [CofounderController, CofounderPeopleController, CofounderConfigController],
  providers: [
    CofounderPoolService,
    CofounderSettingsService,
    CofounderDividendService,
    CofounderEnrollmentService,
    CofounderReviewService,
    CofounderAdminService,
    { provide: CofounderActivationSettler, useExisting: CofounderEnrollmentService },
  ],
  exports: [
    CofounderDividendService,
    CofounderEnrollmentService,
    CofounderPoolService,
    CofounderSettingsService,
    CofounderActivationSettler,
  ],
})
export class CofounderModule {}
