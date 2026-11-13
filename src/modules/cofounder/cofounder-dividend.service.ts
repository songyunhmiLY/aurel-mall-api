import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { AwardCreditService } from '../rewards/award-credit.service';
import { applyBps } from '../rewards/award-split';
import { WALLET_WITHDRAWABLE } from '../wallet/wallet.constants';
import { latestDueSlot } from './cofounder-schedule';
import { perPersonShareReached, splitEvenly } from './cofounder-split';
import { CofounderPoolService } from './cofounder-pool.service';
import { CofounderSettingsService } from './cofounder-settings.service';
import {
  COFOUNDER_BASE_GOODS,
  COFOUNDER_BASE_PV,
  COFOUNDER_BIZ,
  COFOUNDER_STATUS_ACTIVE,
  MAX_FEN,
  PAYOUT_IMMEDIATE,
  PAYOUT_PER_PERSON,
  PAYOUT_PERIODIC,
  PAYOUT_POOL_TOTAL,
  isUniqueConflict,
  type CofounderSettings,
  type Tx,
} from './cofounder.constants';

export interface PaidOrderInput {
  id: bigint;
  userId: bigint;
  zone: string;
  goodsTotalFen: number;
  pvFen: number;
}

/**
 * 联合创始人分红。只认已支付的创业专区订单和会员商城订单。
 * 创业专区基数是 orders.goods_total_fen：N × 件数，含钱包支付的货款，不含运费，不用 wechat_fen。
 * 商城基数是 orders.pv_fen（1 PV = 1 元）。两条比例都在进程启动时读入。
 * 100% 进入可提现账户，来源 cofounder，显示分类默认「系统奖励」。
 * 发放时只分给当时仍在籍的人。余数和无人在籍的金额留在系统。
 */
@Injectable()
export class CofounderDividendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly credits: AwardCreditService,
    private readonly pool: CofounderPoolService,
    private readonly settings: CofounderSettingsService,
  ) {}

  async onPaidOrder(tx: Tx, order: PaidOrderInput, now: Date): Promise<void> {
    const quote = this.quote(order);
    if (!quote || quote.amountFen <= 0n) {
      return;
    }
    await this.pool.lock(tx, now);
    const existing = await tx.cofounderAccrual.findUnique({ where: { orderId: order.id } });
    if (existing) {
      return;
    }
    await tx.cofounderAccrual.create({
      data: {
        orderId: order.id,
        userId: order.userId,
        zone: order.zone,
        baseField: quote.baseField,
        baseFen: quote.baseFen,
        ratioBps: quote.ratioBps,
        amountFen: quote.amountFen,
        occurredAt: now,
        createdAt: now,
      },
    });
    const current = await this.settings.readFrom(tx);
    if (current.payoutMode === PAYOUT_IMMEDIATE) {
      await this.distribute(
        tx,
        quote.amountFen,
        `order:${order.id.toString()}`,
        PAYOUT_IMMEDIATE,
        now,
        order.id,
      );
      return;
    }
    const locked = await this.pool.lock(tx, now);
    const next = locked.balanceFen + quote.amountFen;
    if (next > MAX_FEN) {
      throw new BadRequestException('奖池金额超出范围');
    }
    await this.pool.setBalance(tx, locked.id, next, now);
    await this.releasePoolIfDue(tx, now, `order:${order.id.toString()}`, true);
  }

  /**
   * 定期分配。只看业务时钟，不看机器本地钟。
   * 已经处理过的档期直接跳过。池子为 0 也把档期记上，避免空转。
   */
  async runDue(): Promise<void> {
    const now = await this.clock.now();
    const current = await this.settings.get();
    if (current.payoutMode !== PAYOUT_PERIODIC) {
      return;
    }
    const slot = latestDueSlot(now, current.schedule);
    if (!slot) {
      return;
    }
    const seen = await this.prisma.cofounderScheduleSlot.findUnique({
      where: { slotKey: slot.key },
    });
    if (seen) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      const again = await tx.cofounderScheduleSlot.findUnique({ where: { slotKey: slot.key } });
      if (again) {
        return;
      }
      const fresh = await this.settings.readFrom(tx);
      if (fresh.payoutMode !== PAYOUT_PERIODIC) {
        return;
      }
      const due = latestDueSlot(now, fresh.schedule);
      if (!due || due.key !== slot.key) {
        return;
      }
      const locked = await this.pool.lock(tx, now);
      if (locked.balanceFen > 0n) {
        await this.payPool(
          tx,
          locked.id,
          locked.balanceFen,
          `schedule:${slot.key}`,
          PAYOUT_PERIODIC,
          now,
        );
      }
      try {
        await tx.cofounderScheduleSlot.create({
          data: { slotKey: slot.key, processedAt: now, createdAt: now },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    });
  }

  /**
   * 切换分配方式或定期周期之前调用。即时分配且池子为空时什么都不做。
   * 有在籍的人就立刻分完并清零；没有人就把池子留给系统再清零。
   * 切到定期分配时，把当前已经到点的档期标成处理过，避免刚切过去就再发一次。
   */
  async flushForSettingsChange(
    tx: Tx,
    previous: CofounderSettings,
    next: CofounderSettings,
    now: Date,
    triggerKey: string,
    markSchedule: boolean,
  ): Promise<void> {
    const locked = await this.pool.lock(tx, now);
    const skip = previous.payoutMode === PAYOUT_IMMEDIATE && locked.balanceFen === 0n;
    if (!skip && locked.balanceFen > 0n) {
      await this.payPool(tx, locked.id, locked.balanceFen, triggerKey, 'mode_switch', now);
    }
    if (markSchedule && next.payoutMode === PAYOUT_PERIODIC) {
      const slot = latestDueSlot(now, next.schedule);
      if (slot) {
        await this.markSlot(tx, slot.key, now);
      }
    }
  }

  /**
   * 门槛改低之后，如果池子已经达到新门槛，立刻按新规则分掉。
   * 没到门槛不动。没人在籍时，只有池子总额模式已经达到门槛才清给系统。
   */
  async releaseAfterThresholdChange(tx: Tx, now: Date, triggerKey: string): Promise<void> {
    const current = await this.settings.readFrom(tx);
    if (current.payoutMode !== PAYOUT_POOL_TOTAL && current.payoutMode !== PAYOUT_PER_PERSON) {
      return;
    }
    const locked = await this.pool.lock(tx, now);
    if (locked.balanceFen <= 0n) {
      return;
    }
    const enrolledCount = await this.countEnrolled(tx);
    if (current.payoutMode === PAYOUT_POOL_TOTAL) {
      if (locked.balanceFen < current.poolThresholdFen) {
        return;
      }
      await this.payPool(tx, locked.id, locked.balanceFen, triggerKey, PAYOUT_POOL_TOTAL, now);
      return;
    }
    if (enrolledCount <= 0) {
      return;
    }
    if (perPersonShareReached(locked.balanceFen, enrolledCount, current.perPersonThresholdFen)) {
      await this.payPool(tx, locked.id, locked.balanceFen, triggerKey, PAYOUT_PER_PERSON, now);
    }
  }

  private async releasePoolIfDue(
    tx: Tx,
    now: Date,
    triggerKey: string,
    zeroWhenUnenrolled: boolean,
  ): Promise<void> {
    const current = await this.settings.readFrom(tx);
    const locked = await this.pool.lock(tx, now);
    if (locked.balanceFen <= 0n) {
      return;
    }
    const enrolledCount = await this.countEnrolled(tx);
    if (enrolledCount === 0) {
      const poolReached =
        current.payoutMode === PAYOUT_POOL_TOTAL &&
        current.poolThresholdFen > 0n &&
        locked.balanceFen >= current.poolThresholdFen;
      const perPersonCheck = current.payoutMode === PAYOUT_PER_PERSON && zeroWhenUnenrolled;
      if (poolReached || perPersonCheck) {
        await this.payPool(tx, locked.id, locked.balanceFen, triggerKey, current.payoutMode, now);
      }
      return;
    }
    if (
      current.payoutMode === PAYOUT_POOL_TOTAL &&
      current.poolThresholdFen > 0n &&
      locked.balanceFen >= current.poolThresholdFen
    ) {
      await this.payPool(tx, locked.id, locked.balanceFen, triggerKey, PAYOUT_POOL_TOTAL, now);
      return;
    }
    if (
      current.payoutMode === PAYOUT_PER_PERSON &&
      perPersonShareReached(locked.balanceFen, enrolledCount, current.perPersonThresholdFen)
    ) {
      await this.payPool(tx, locked.id, locked.balanceFen, triggerKey, PAYOUT_PER_PERSON, now);
    }
  }

  private async payPool(
    tx: Tx,
    poolId: bigint,
    totalFen: bigint,
    triggerKey: string,
    mode: string,
    now: Date,
  ): Promise<void> {
    await this.distribute(tx, totalFen, triggerKey, mode, now, null);
    await this.pool.setBalance(tx, poolId, 0n, now);
  }

  private async distribute(
    tx: Tx,
    totalFen: bigint,
    triggerKey: string,
    mode: string,
    now: Date,
    sourceOrderId: bigint | null,
  ): Promise<void> {
    if (totalFen <= 0n) {
      return;
    }
    const existing = await tx.cofounderPayoutBatch.findUnique({ where: { triggerKey } });
    if (existing) {
      await this.creditExisting(tx, existing.id, now);
      return;
    }
    const enrolled = await tx.cofounderEnrollment.findMany({
      where: { status: COFOUNDER_STATUS_ACTIVE },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
    });
    const split = splitEvenly(totalFen, enrolled.length);
    const batch = await tx.cofounderPayoutBatch.create({
      data: {
        triggerKey,
        mode,
        totalFen,
        enrolledCount: enrolled.length,
        shareFen: split.shareFen,
        distributedFen: split.distributedFen,
        retainedFen: split.retainedFen,
        paidAt: now,
        createdAt: now,
      },
    });
    if (split.shareFen <= 0n) {
      return;
    }
    for (const person of enrolled) {
      await tx.cofounderPayout.create({
        data: {
          batchId: batch.id,
          userId: person.userId,
          amountFen: split.shareFen,
          creditedAt: now,
          createdAt: now,
        },
      });
      await this.creditShare(tx, person.userId, batch.id, split.shareFen, sourceOrderId, now);
    }
  }

  private async creditExisting(tx: Tx, batchId: bigint, now: Date): Promise<void> {
    const payouts = await tx.cofounderPayout.findMany({ where: { batchId } });
    for (const payout of payouts) {
      await this.creditShare(tx, payout.userId, batchId, payout.amountFen, null, now);
    }
  }

  private async creditShare(
    tx: Tx,
    userId: bigint,
    batchId: bigint,
    amountFen: bigint,
    sourceOrderId: bigint | null,
    now: Date,
  ): Promise<void> {
    await this.credits.creditParts(tx, {
      userId,
      parts: [
        {
          walletType: WALLET_WITHDRAWABLE,
          amountFen,
          sourceCode: COFOUNDER_BIZ,
        },
      ],
      bizType: COFOUNDER_BIZ,
      bizId: batchId.toString(),
      rewardType: COFOUNDER_BIZ,
      rewardFen: amountFen,
      orderId: sourceOrderId,
      now,
    });
  }

  private async countEnrolled(tx: Tx): Promise<number> {
    return tx.cofounderEnrollment.count({ where: { status: COFOUNDER_STATUS_ACTIVE } });
  }

  private async markSlot(tx: Tx, slotKey: string, now: Date): Promise<void> {
    const existing = await tx.cofounderScheduleSlot.findUnique({ where: { slotKey } });
    if (existing) {
      return;
    }
    try {
      await tx.cofounderScheduleSlot.create({
        data: { slotKey, processedAt: now, createdAt: now },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
    }
  }

  private quote(order: PaidOrderInput): {
    baseField: string;
    baseFen: bigint;
    ratioBps: number;
    amountFen: bigint;
  } | null {
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      const baseFen = BigInt(order.goodsTotalFen);
      const ratioBps = this.locked.cofounderStartupDividendRatioBps;
      return {
        baseField: COFOUNDER_BASE_GOODS,
        baseFen,
        ratioBps,
        amountFen: applyBps(baseFen, ratioBps),
      };
    }
    if (order.zone === PRODUCT_ZONE_MALL) {
      const baseFen = BigInt(order.pvFen);
      const ratioBps = this.locked.cofounderMallDividendRatioBps;
      return {
        baseField: COFOUNDER_BASE_PV,
        baseFen,
        ratioBps,
        amountFen: applyBps(baseFen, ratioBps),
      };
    }
    return null;
  }
}
