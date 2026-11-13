import { Inject, Injectable } from '@nestjs/common';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { AwardCreditService } from '../rewards/award-credit.service';
import { applyBps } from '../rewards/award-split';
import { WALLET_WITHDRAWABLE } from '../wallet/wallet.constants';
import {
  STUDIO_BASE_GOODS,
  STUDIO_BASE_PV,
  STUDIO_BIZ,
  STUDIO_STATUS_ACTIVE,
  isUniqueConflict,
  type Tx,
} from './studio.constants';

export interface PaidOrderInput {
  id: bigint;
  userId: bigint;
  zone: string;
  goodsTotalFen: number;
  pvFen: number;
}

interface Quote {
  baseField: string;
  baseFen: bigint;
  ratioBps: number;
  amountFen: bigint;
}

/**
 * 工作室补贴。支付成功时立刻入账，不进池，也不在工作室之间拆分。
 * 创业专区看市场树（含本人），基数是 goods_total_fen。
 * 商城看邀请树（含本人），基数是 pv_fen。
 * 同一订单落在多名工作室的树里时，每人按自己的树各记一笔。
 * 100% 进入可提现账户，来源 studio。不写现金流水。
 */
@Injectable()
export class StudioSubsidyService {
  constructor(
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly credits: AwardCreditService,
  ) {}

  async onPaidOrder(tx: Tx, order: PaidOrderInput, now: Date): Promise<void> {
    const quote = this.quote(order);
    if (!quote || quote.amountFen <= 0n) {
      return;
    }
    const prior = await tx.studioAccrual.findMany({ where: { orderId: order.id } });
    if (prior.length > 0) {
      return;
    }
    const node = await this.loadNode(tx, order);
    if (!node) {
      return;
    }
    const userIds = idsOnPath(node.path, order.userId);
    const enrolled = await tx.studioEnrollment.findMany({
      where: { status: STUDIO_STATUS_ACTIVE, userId: { in: userIds } },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
    });
    const seen = new Set<string>();
    for (const person of enrolled) {
      const key = person.userId.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      try {
        await tx.studioAccrual.create({
          data: {
            orderId: order.id,
            userId: person.userId,
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
          continue;
        }
        throw error;
      }
      await this.credits.creditParts(tx, {
        userId: person.userId,
        parts: [
          {
            walletType: WALLET_WITHDRAWABLE,
            amountFen: quote.amountFen,
            sourceCode: STUDIO_BIZ,
          },
        ],
        bizType: STUDIO_BIZ,
        bizId: order.id.toString(),
        rewardType: STUDIO_BIZ,
        rewardFen: quote.amountFen,
        orderId: order.id,
        now,
      });
    }
  }

  private quote(order: PaidOrderInput): Quote | null {
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      const baseFen = BigInt(order.goodsTotalFen);
      const ratioBps = this.locked.studioStartupSubsidyRatioBps;
      return {
        baseField: STUDIO_BASE_GOODS,
        baseFen,
        ratioBps,
        amountFen: applyBps(baseFen, ratioBps),
      };
    }
    if (order.zone === PRODUCT_ZONE_MALL) {
      const baseFen = BigInt(order.pvFen);
      const ratioBps = this.locked.studioMallSubsidyRatioBps;
      return {
        baseField: STUDIO_BASE_PV,
        baseFen,
        ratioBps,
        amountFen: applyBps(baseFen, ratioBps),
      };
    }
    return null;
  }

  private async loadNode(tx: Tx, order: PaidOrderInput): Promise<{ path: string } | null> {
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      return tx.marketTreeNode.findUnique({ where: { userId: order.userId } });
    }
    if (order.zone === PRODUCT_ZONE_MALL) {
      return tx.inviteTreeNode.findUnique({ where: { userId: order.userId } });
    }
    return null;
  }
}

function idsOnPath(path: string, self: bigint): bigint[] {
  const ids: bigint[] = [];
  const seen = new Set<string>();
  for (const part of path.split('/')) {
    if (!/^\d+$/.test(part)) {
      continue;
    }
    const id = BigInt(part);
    const key = id.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ids.push(id);
  }
  const selfKey = self.toString();
  if (!seen.has(selfKey)) {
    ids.push(self);
  }
  return ids;
}
