import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { RedisClockOverrideStore } from './clock-override.store';
import {
  BUSINESS_TIMEZONE,
  shanghaiBizDate,
  startOfShanghaiDay,
  startOfShanghaiMonth,
} from './shanghai-calendar';

export interface ResolvedClock {
  now: Date;
  realNow: Date;
  source: 'real' | 'override';
}

export interface ClockDescription {
  now: string;
  realNow: string;
  source: 'real' | 'override';
  timezone: typeof BUSINESS_TIMEZONE;
  startOfDay: string;
  startOfMonth: string;
  bizDate: string;
}

export interface ClockOverrideView {
  allowed: boolean;
  source: 'real' | 'override';
  now: string;
  realNow: string;
  override: string | null;
  timezone: typeof BUSINESS_TIMEZONE;
}

/**
 * 业务当前时间的唯一入口。
 * 是否接受覆盖只看 ALLOW_CLOCK_OVERRIDE。开关关闭时忽略一切覆盖请求，
 * 也不读取已保存的覆盖值。不看主机名、来源地址或额外密钥。
 */
@Injectable()
export class ClockService {
  private readonly logger = new Logger(ClockService.name);

  constructor(
    private readonly store: RedisClockOverrideStore,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async now(): Promise<Date> {
    const resolved = await this.resolve();
    return resolved.now;
  }

  /**
   * 系统真实时间，忽略一切覆盖。
   * 只给「不是业务数据」的场景用，例如管理员登录态的有效期：
   * 仿真台把业务时钟推到几个月后，不该顺带把正在操作的人踢出登录。
   * 业务时间仍然一律走 now()。
   */
  async realNow(): Promise<Date> {
    return new Date();
  }

  /** 由已知的 Unix 毫秒构造时刻，不是读取当前时间。 */
  instant(unixMs: number): Date {
    return new Date(unixMs);
  }

  async startOfDay(instant?: Date): Promise<Date> {
    return startOfShanghaiDay(instant ?? (await this.now()));
  }

  async startOfMonth(instant?: Date): Promise<Date> {
    return startOfShanghaiMonth(instant ?? (await this.now()));
  }

  async bizDate(instant?: Date): Promise<string> {
    return shanghaiBizDate(instant ?? (await this.now()));
  }

  async resolve(): Promise<ResolvedClock> {
    // 真实时间只在这里读取。业务代码不能自己取系统时间当作当前时间。
    const realNow = new Date();
    if (!this.env.allowClockOverride) {
      return { now: realNow, realNow, source: 'real' };
    }
    const override = await this.store.get();
    if (!override) {
      return { now: realNow, realNow, source: 'real' };
    }
    return { now: override, realNow, source: 'override' };
  }

  async describe(): Promise<ClockDescription> {
    const resolved = await this.resolve();
    return {
      now: resolved.now.toISOString(),
      realNow: resolved.realNow.toISOString(),
      source: resolved.source,
      timezone: BUSINESS_TIMEZONE,
      startOfDay: startOfShanghaiDay(resolved.now).toISOString(),
      startOfMonth: startOfShanghaiMonth(resolved.now).toISOString(),
      bizDate: shanghaiBizDate(resolved.now),
    };
  }

  async readOverride(): Promise<ClockOverrideView> {
    const resolved = await this.resolve();
    return this.toView(resolved, this.env.allowClockOverride);
  }

  async setOverride(iso: string): Promise<ClockOverrideView> {
    this.assertOverrideEnabled();
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('无效的 ISO 时间');
    }
    await this.store.set(parsed);
    this.logger.log(`clock override set to ${parsed.toISOString()}`);
    return this.toView(await this.resolve(), true);
  }

  async clearOverride(): Promise<ClockOverrideView> {
    this.assertOverrideEnabled();
    await this.store.clear();
    this.logger.log('clock override cleared');
    return this.toView(await this.resolve(), true);
  }

  private assertOverrideEnabled(): void {
    if (!this.env.allowClockOverride) {
      this.logger.warn('clock override ignored because ALLOW_CLOCK_OVERRIDE is off');
      throw new ForbiddenException('时钟覆盖未启用，本次操作已忽略');
    }
  }

  private toView(resolved: ResolvedClock, allowed: boolean): ClockOverrideView {
    return {
      allowed,
      source: resolved.source,
      now: resolved.now.toISOString(),
      realNow: resolved.realNow.toISOString(),
      override: resolved.source === 'override' ? resolved.now.toISOString() : null,
      timezone: BUSINESS_TIMEZONE,
    };
  }
}
