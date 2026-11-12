import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { UsersModule } from '../users/users.module';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogPublicController } from './catalog-public.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [AuthModule, ClockModule, UsersModule],
  controllers: [CatalogPublicController, CatalogAdminController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
