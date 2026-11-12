import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MARKETING_MANAGER_MARKET_THRESHOLD_KEY } from './settings.constants';

export interface MarketThresholdSetting {
  key: string;
  value: string;
  updatedAt: string;
}

/**
 * 只管理允许管理员修改的配置。
 * 需求 §1.1 的锁定项来自环境变量，不进入本服务。
 * 营销经理市场门槛 T 在首次启动时写入默认值，之后重启不会覆盖已有值。
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    const now = await this.clock.now();
    try {
      await this.prisma.adminSetting.upsert({
        where: { settingKey: MARKETING_MANAGER_MARKET_THRESHOLD_KEY },
        create: {
          settingKey: MARKETING_MANAGER_MARKET_THRESHOLD_KEY,
          settingValue: this.env.marketingManagerMarketThresholdDefault,
          updatedAt: now,
        },
        update: {},
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
    }
  }

  async getMarketingManagerMarketThreshold(): Promise<MarketThresholdSetting> {
    const row = await this.prisma.adminSetting.findUnique({
      where: { settingKey: MARKETING_MANAGER_MARKET_THRESHOLD_KEY },
    });
    if (!row) {
      throw new NotFoundException('营销经理市场门槛尚未写入');
    }
    return toSetting(row.settingKey, row.settingValue, row.updatedAt);
  }

  async setMarketingManagerMarketThreshold(
    value: string,
    adminUserId: bigint | null,
  ): Promise<MarketThresholdSetting> {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('门槛 T 必须是非负整数');
    }
    const now = await this.clock.now();
    const row = await this.prisma.adminSetting.upsert({
      where: { settingKey: MARKETING_MANAGER_MARKET_THRESHOLD_KEY },
      create: {
        settingKey: MARKETING_MANAGER_MARKET_THRESHOLD_KEY,
        settingValue: value,
        updatedAt: now,
        updatedByAdminId: adminUserId,
      },
      update: {
        settingValue: value,
        updatedAt: now,
        updatedByAdminId: adminUserId,
      },
    });
    return toSetting(row.settingKey, row.settingValue, row.updatedAt);
  }
}

function toSetting(key: string, value: string, updatedAt: Date): MarketThresholdSetting {
  return { key, value, updatedAt: updatedAt.toISOString() };
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
