import { Module } from '@nestjs/common';
import { AuthModule } from '../../../common/auth/auth.module';
import { AwardAdminController } from './award-admin.controller';
import { AwardAdminService } from './award-admin.service';

@Module({
  imports: [AuthModule],
  controllers: [AwardAdminController],
  providers: [AwardAdminService],
  exports: [AwardAdminService],
})
export class AwardAdminModule {}
