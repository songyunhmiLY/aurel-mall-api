import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import {
  SIMULATION_TIMELINE_CAP,
  type SimulationEvent,
  type SimulationStore,
} from './simulation.types';

const SIMULATION_TIMELINE_KEY = 'aurel:simulation:timeline';

/** 时间轴存 Redis：进程重启不丢，多实例共享。超过上限裁掉最旧的。 */
@Injectable()
export class RedisSimulationStore implements SimulationStore {
  constructor(private readonly redis: RedisService) {}

  async append(event: SimulationEvent): Promise<void> {
    const client = this.redis.client;
    await client.rpush(SIMULATION_TIMELINE_KEY, JSON.stringify(event));
    await client.ltrim(SIMULATION_TIMELINE_KEY, -SIMULATION_TIMELINE_CAP, -1);
  }

  async list(): Promise<SimulationEvent[]> {
    const raw = await this.redis.client.lrange(SIMULATION_TIMELINE_KEY, 0, -1);
    const events: SimulationEvent[] = [];
    for (const item of raw) {
      try {
        events.push(JSON.parse(item) as SimulationEvent);
      } catch {
        // 单条损坏不影响其余时间轴。
      }
    }
    return events;
  }

  async clear(): Promise<void> {
    await this.redis.client.del(SIMULATION_TIMELINE_KEY);
  }
}
