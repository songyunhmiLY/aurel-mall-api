import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DUE_QUEUE } from './jobs.constants';
import { DueJobRunner } from './due-job.runner';

@Injectable()
export class DueJobScheduler implements OnModuleInit {
  private readonly logger = new Logger(DueJobScheduler.name);

  constructor(
    @InjectQueue(DUE_QUEUE) private readonly queue: Queue,
    private readonly runner: DueJobRunner,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'due-jobs-tick',
      { every: 30_000 },
      { name: 'run-due', data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } },
    );
    await this.runner.runDue();
    this.logger.log('due jobs scheduled');
  }
}
