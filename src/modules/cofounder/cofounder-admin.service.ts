import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { sameSchedule } from './cofounder-schedule';
import { CofounderDividendService } from './cofounder-dividend.service';
import { CofounderEnrollmentService, type EnrollmentView } from './cofounder-enrollment.service';
import { CofounderPoolService } from './cofounder-pool.service';
import { CofounderReviewService, type CancellationReview } from './cofounder-review.service';
import {
  assertSettingsInput,
  CofounderSettingsService,
  type CofounderContent,
} from './cofounder-settings.service';
import {
  COFOUNDER_STATUS_ACTIVE,
  PAYOUT_PERIODIC,
  type CofounderSettings,
} from './cofounder.constants';

export interface CofounderSettingsView extends CofounderSettings {
  enrolledCount: number;
  poolFen: bigint;
  lockedRates: { startupDividendRatioBps: number; mallDividendRatioBps: number };
}

/**
 * 管理端配置。改分配方式或定期周期时，先处理池子里已有的金额，再启用新配置。
 * 锁定的分红比例只读，不接收写入。
 */
@Injectable()
export class CofounderAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly settings: CofounderSettingsService,
    private readonly pool: CofounderPoolService,
    private readonly dividend: CofounderDividendService,
    private readonly enrollment: CofounderEnrollmentService,
    private readonly review: CofounderReviewService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
  ) {}

  async getSettings(): Promise<CofounderSettingsView> {
    const [settings, enrolledCount, poolFen] = await Promise.all([
      this.settings.get(),
      this.prisma.cofounderEnrollment.count({ where: { status: COFOUNDER_STATUS_ACTIVE } }),
      this.pool.readBalance(),
    ]);
    return this.view(settings, enrolledCount, poolFen);
  }

  async updateSettings(input: CofounderSettings, adminId: bigint): Promise<CofounderSettingsView> {
    const next = assertSettingsInput(input);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const previous = await this.settings.readFrom(tx);
      const modeChanged = previous.payoutMode !== next.payoutMode;
      const periodChanged = !sameSchedule(previous.schedule, next.schedule);
      const flush =
        modeChanged ||
        (periodChanged &&
          (previous.payoutMode === PAYOUT_PERIODIC || next.payoutMode === PAYOUT_PERIODIC));
      const thresholdChanged =
        previous.poolThresholdFen !== next.poolThresholdFen ||
        previous.perPersonThresholdFen !== next.perPersonThresholdFen;
      if (flush) {
        const triggerKey = `mode-switch:${now.getTime().toString()}:${randomBytes(4).toString('hex')}`;
        await this.dividend.flushForSettingsChange(
          tx,
          previous,
          next,
          now,
          triggerKey,
          modeChanged || periodChanged,
        );
      }
      await this.settings.write(tx, next, adminId, now);
      if (!flush && thresholdChanged) {
        const triggerKey = `threshold:${now.getTime().toString()}:${randomBytes(4).toString('hex')}`;
        await this.dividend.releaseAfterThresholdChange(tx, now, triggerKey);
      }
    });
    return this.getSettings();
  }

  getContent(): Promise<CofounderContent> {
    return this.settings.getContent();
  }

  setContent(input: CofounderContent, adminId: bigint): Promise<CofounderContent> {
    return this.settings.setContent(input, adminId);
  }

  list(query: { status?: string; page: number; pageSize: number }) {
    return this.enrollment.list(query);
  }

  appoint(userId: bigint, adminId: bigint): Promise<EnrollmentView> {
    return this.enrollment.appoint(userId, adminId);
  }

  cancel(userId: bigint, adminId: bigint): Promise<EnrollmentView> {
    return this.enrollment.cancel(userId, adminId);
  }

  cancellation(userId: bigint): Promise<CancellationReview> {
    return this.review.review(userId);
  }

  private view(
    settings: CofounderSettings,
    enrolledCount: number,
    poolFen: bigint,
  ): CofounderSettingsView {
    return {
      ...settings,
      enrolledCount,
      poolFen,
      lockedRates: {
        startupDividendRatioBps: this.locked.cofounderStartupDividendRatioBps,
        mallDividendRatioBps: this.locked.cofounderMallDividendRatioBps,
      },
    };
  }
}
