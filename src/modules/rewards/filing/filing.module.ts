import { Module } from '@nestjs/common';
import { FilingService } from './filing.service';

@Module({
  providers: [FilingService],
  exports: [FilingService],
})
export class FilingModule {}
