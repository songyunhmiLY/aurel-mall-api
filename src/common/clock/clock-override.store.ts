import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export const CLOCK_OVERRIDE_KEY = 'aurel:clock:override';

@Injectable()
export class RedisClockOverrideStore {
  constructor(private readonly redis: RedisService) {}

  async get(): Promise<Date | null> {
    const raw = await this.redis.client.get(CLOCK_OVERRIDE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  async set(value: Date): Promise<void> {
    await this.redis.client.set(CLOCK_OVERRIDE_KEY, value.toISOString());
  }

  async clear(): Promise<void> {
    await this.redis.client.del(CLOCK_OVERRIDE_KEY);
  }
}
