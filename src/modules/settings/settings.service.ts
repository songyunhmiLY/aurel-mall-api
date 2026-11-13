import { BadRequestException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { ClockService } from '../../common/clock/clock.service';
import { nextBizMonth, shanghaiBizMonth } from '../../common/clock/shanghai-calendar';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MARKETING_MANAGER_MARKET_THRESHOLD_KEY } from './settings.constants';

const MAX_FEN = 9223372036854775807n;

export interface MarketThresholdSetting {
  month: string;
  thresholdFen: bigint;
  nextMonth: string;
  nextThresholdFen: bigint;
}

/**
 * 只管理允许管理员修改的配置。
 * 需求 §1.1 的锁定项来自环境变量，不进入本服务。
 * 营销经理门槛 T 改完只从下一个自然月开始生效。单位是分。
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.marketThresholdRevision.findFirst();
    if (existing) {
      return;
    }
    const now = await this.clock.now();
    const legacy = await this.prisma.adminSetting.findUnique({
      where: { settingKey: MARKETING_MANAGER_MARKET_THRESHOLD_KEY },
    });
    const raw = legacy?.settingValue ?? this.env.marketingManagerMarketThresholdDefault;
    await this.prisma.marketThresholdRevision.create({
      data: {
        effectiveMonth: shanghaiBizMonth(now),
        thresholdFen: parseThreshold(raw),
        updatedByAdminId: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  async thresholdForMonth(month: string): Promise<bigint> {
    const rows = await this.prisma.marketThresholdRevision.findMany();
    const applicable = rows
      .filter((row) => row.effectiveMonth <= month)
      .sort((left, right) => (left.effectiveMonth < right.effectiveMonth ? 1 : -1));
    const chosen = applicable[0];
    if (chosen) {
      return chosen.thresholdFen;
    }
    return parseThreshold(this.env.marketingManagerMarketThresholdDefault);
  }

  async getMarketingManagerMarketThreshold(): Promise<MarketThresholdSetting> {
    const now = await this.clock.now();
    const month = shanghaiBizMonth(now);
    const nextMonth = nextBizMonth(month);
    const [thresholdFen, nextThresholdFen] = await Promise.all([
      this.thresholdForMonth(month),
      this.thresholdForMonth(nextMonth),
    ]);
    return { month, thresholdFen, nextMonth, nextThresholdFen };
  }

  async setMarketingManagerMarketThreshold(
    value: string,
    adminUserId: bigint | null,
  ): Promise<MarketThresholdSetting> {
    const thresholdFen = parseThreshold(value);
    const now = await this.clock.now();
    const nextMonth = nextBizMonth(shanghaiBizMonth(now));
    const existing = await this.prisma.marketThresholdRevision.findUnique({
      where: { effectiveMonth: nextMonth },
    });
    if (existing) {
      await this.prisma.marketThresholdRevision.update({
        where: { id: existing.id },
        data: { thresholdFen, updatedAt: now, updatedByAdminId: adminUserId },
      });
    } else {
      await this.prisma.marketThresholdRevision.create({
        data: {
          effectiveMonth: nextMonth,
          thresholdFen,
          updatedByAdminId: adminUserId,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    return this.getMarketingManagerMarketThreshold();
  }
}

function parseThreshold(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException('门槛 T 必须是非负整数');
  }
  const fen = BigInt(value);
  if (fen > MAX_FEN) {
    throw new BadRequestException('门槛 T 超出范围');
  }
  return fen;
}
