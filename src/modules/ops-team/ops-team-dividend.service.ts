import { Inject, Injectable } from '@nestjs/common';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { AwardCreditService } from '../rewards/award-credit.service';
import { applyBps } from '../rewards/award-split';
import { WALLET_WITHDRAWABLE } from '../wallet/wallet.constants';
import { OpsTeamEnrollmentService } from './ops-team-enrollment.service';
import {
  OPS_TEAM_BASE_GOODS,
  OPS_TEAM_BASE_PV,
  OPS_TEAM_BIZ_MALL,
  OPS_TEAM_BIZ_STARTUP,
  OPS_TEAM_REWARD,
  OPS_TEAM_SOURCE,
  isUniqueConflict,
  type Tx,
} from './ops-team.constants';

export interface PaidOrderInput {
  id: bigint;
  userId: bigint;
  zone: string;
  goodsTotalFen: number;
  pvFen: number;
}

interface Quote {
  bizType: string;
  baseField: string;
  baseFen: bigint;
  ratioBps: number;
  amountFen: bigint;
}

/**
 * 运营团队分红。支付成功时立刻入账给当时那一名持有人。
 * 不进池，不按市场树或邀请树，也不与其他人拆分。
 * 创业专区基数是 goods_total_fen。商城基数是 pv_fen。
 * 100% 进入可提现账户，来源 operations。两条流水的 bizType 分开。
 * 不写现金流水。没人在籍，或金额为 0，都不入账。
 */
@Injectable()
export class OpsTeamDividendService {
  constructor(
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly credits: AwardCreditService,
    private readonly enrollment: OpsTeamEnrollmentService,
  ) {}

  async onPaidOrder(tx: Tx, order: PaidOrderInput, now: Date): Promise<void> {
    const quote = this.quote(order);
    if (!quote || quote.amountFen <= 0n) {
      return;
    }
    const prior = await tx.opsTeamAccrual.findUnique({ where: { orderId: order.id } });
    if (prior) {
      return;
    }
    const holder = await this.enrollment.lockHolder(tx, now);
    if (!holder) {
      return;
    }
    try {
      await tx.opsTeamAccrual.create({
        data: {
          orderId: order.id,
          userId: holder.userId,
          zone: order.zone,
          baseField: quote.baseField,
          baseFen: quote.baseFen,
          ratioBps: quote.ratioBps,
          amountFen: quote.amountFen,
          occurredAt: now,
          createdAt: now,
        },
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return;
      }
      throw error;
    }
    await this.credits.creditParts(tx, {
      userId: holder.userId,
      parts: [
        {
          walletType: WALLET_WITHDRAWABLE,
          amountFen: quote.amountFen,
          sourceCode: OPS_TEAM_SOURCE,
        },
      ],
      bizType: quote.bizType,
      bizId: order.id.toString(),
      rewardType: OPS_TEAM_REWARD,
      rewardFen: quote.amountFen,
      orderId: order.id,
      now,
    });
  }

  private quote(order: PaidOrderInput): Quote | null {
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      const baseFen = BigInt(order.goodsTotalFen);
      const ratioBps = this.locked.opsTeamStartupDividendRatioBps;
      return {
        bizType: OPS_TEAM_BIZ_STARTUP,
        baseField: OPS_TEAM_BASE_GOODS,
        baseFen,
        ratioBps,
        amountFen: applyBps(baseFen, ratioBps),
      };
    }
    if (order.zone === PRODUCT_ZONE_MALL) {
      const baseFen = BigInt(order.pvFen);
      const ratioBps = this.locked.opsTeamMallDividendRatioBps;
      return {
        bizType: OPS_TEAM_BIZ_MALL,
        baseField: OPS_TEAM_BASE_PV,
        baseFen,
        ratioBps,
        amountFen: applyBps(baseFen, ratioBps),
      };
    }
    return null;
  }
}
