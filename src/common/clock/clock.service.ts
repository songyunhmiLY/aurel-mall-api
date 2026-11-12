import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { isClockOverrideCallerAllowed, type ClockCaller } from './clock-access';
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

  async readOverride(caller: ClockCaller): Promise<ClockOverrideView> {
    const resolved = await this.resolve();
    if (!this.callerMayMutate(caller)) {
      return {
        allowed: false,
        source: 'real',
        now: resolved.realNow.toISOString(),
        realNow: resolved.realNow.toISOString(),
        override: null,
        timezone: BUSINESS_TIMEZONE,
      };
    }
    return this.toView(resolved, true);
  }

  async setOverride(iso: string, caller: ClockCaller): Promise<ClockOverrideView> {
    this.assertCaller(caller);
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('无效的 ISO 时间');
    }
    await this.store.set(parsed);
    this.logger.log(`clock override set to ${parsed.toISOString()}`);
    return this.toView(await this.resolve(), true);
  }

  async clearOverride(caller: ClockCaller): Promise<ClockOverrideView> {
    this.assertCaller(caller);
    await this.store.clear();
    this.logger.log('clock override cleared');
    return this.toView(await this.resolve(), true);
  }

  private assertCaller(caller: ClockCaller): void {
    if (!this.callerMayMutate(caller)) {
      this.logger.warn('clock override ignored');
      throw new ForbiddenException('时钟覆盖未启用或调用方不在允许范围，本次操作已忽略');
    }
  }

  private callerMayMutate(caller: ClockCaller): boolean {
    return this.env.allowClockOverride && isClockOverrideCallerAllowed(caller);
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
