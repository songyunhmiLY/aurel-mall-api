import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';
import { AuthController } from './auth.controller';
import { InviterController } from './inviter.controller';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { PreviewAuthEnabledGuard } from './preview-auth.guard';
import { UsersService } from './users.service';
import { WechatMiniClient } from './wechat-mini.client';

@Module({
  imports: [AuthModule, ClockModule],
  controllers: [AuthController, InviterController, KycController, AddressesController],
  providers: [
    UsersService,
    KycService,
    AddressesService,
    WechatMiniClient,
    PreviewAuthEnabledGuard,
  ],
  exports: [UsersService, KycService],
})
export class UsersModule {}
