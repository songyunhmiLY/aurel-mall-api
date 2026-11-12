import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PLACEHOLDER_QUEUE } from './jobs.constants';

/**
 * 队列占位，不执行业务。
 * 以后的任务取业务时间必须注入 ClockService，以便和 API 共用 Redis 里的测试时间。
 */
@Processor(PLACEHOLDER_QUEUE)
export class PlaceholderProcessor extends WorkerHost {
  override async process(_job: Job): Promise<{ ignored: true }> {
    return { ignored: true };
  }
}
