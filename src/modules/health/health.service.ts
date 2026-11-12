import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ClockService, type ClockDescription } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

export interface HealthReport {
  status: 'ok' | 'degraded';
  mysql: 'up' | 'down';
  redis: 'up' | 'down';
  clock: ClockDescription | null;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clock: ClockService,
  ) {}

  async check(): Promise<HealthReport> {
    const [mysql, redis, clock] = await Promise.all([
      this.pingMysql(),
      this.pingRedis(),
      this.readClock(),
    ]);
    const report: HealthReport = {
      status: mysql === 'up' && redis === 'up' && clock ? 'ok' : 'degraded',
      mysql,
      redis,
      clock,
    };
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException({ message: '依赖不可用', data: report });
    }
    return report;
  }

  private async pingMysql(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async pingRedis(): Promise<'up' | 'down'> {
    try {
      const pong = await this.redis.client.ping();
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  private async readClock(): Promise<ClockDescription | null> {
    try {
      return await this.clock.describe();
    } catch {
      return null;
    }
  }
}
