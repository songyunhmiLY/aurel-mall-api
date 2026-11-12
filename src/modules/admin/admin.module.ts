import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';

@Module({
  imports: [AuthModule, ClockModule],
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
})
export class AdminModule {}
