import { Module } from '@nestjs/common';
import { TreesService } from './trees.service';

@Module({
  providers: [TreesService],
  exports: [TreesService],
})
export class TreesModule {}
