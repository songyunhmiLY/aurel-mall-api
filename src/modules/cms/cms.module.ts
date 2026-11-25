import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { CmsService } from './cms.service';
import { HomeAdminController } from './home-admin.controller';
import { HomePublicController } from './home-public.controller';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [AuthModule, ClockModule],
  controllers: [UploadsController, HomePublicController, HomeAdminController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
