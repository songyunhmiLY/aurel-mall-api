import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DUE_QUEUE } from './jobs.constants';
import { DueJobRunner } from './due-job.runner';

@Processor(DUE_QUEUE)
export class DueJobProcessor extends WorkerHost {
  constructor(private readonly runner: DueJobRunner) {
    super();
  }

  override async process(_job: Job): Promise<{ ran: true }> {
    await this.runner.runDue();
    return { ran: true };
  }
}
