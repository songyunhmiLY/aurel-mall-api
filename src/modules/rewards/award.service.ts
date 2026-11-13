import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { AwardCreditService } from './award-credit.service';
import { applyBps } from './award-split';

type Tx = Prisma.TransactionClient;

const STARTUP_LAYER_MAX = 12;
const MALL_LAYER_MAX = 15;
const SOURCE_STARTUP_SALES = 'startup_sales';
const SOURCE_STARTUP_POINTS = 'startup_points';
const SOURCE_MALL_SALES = 'mall_sales';
const SOURCE_MALL_POINTS = 'mall_points';

/**
 * 支付成功后的销售奖和见点奖。与报单是否已经完成无关。
 * 创业专区走邀请树直推销售奖，以及市场上级的见点奖。
 * 商城只走邀请树：第 1 层是销售奖，第 2 到 15 层是见点奖，第 1 层不再领见点奖。
 */
@Injectable()
export class AwardService {
  constructor(
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
    private readonly credits: AwardCreditService,
  ) {}

  async grantForPaidOrder(
    tx: Tx,
    order: {
      id: bigint;
      userId: bigint;
      zone: string;
      payAmountFen: number;
      pvFen: number;
    },
    now: Date,
  ): Promise<void> {
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      await this.grantStartup(tx, order, now);
      return;
    }
    if (order.zone === PRODUCT_ZONE_MALL) {
      await this.grantMall(tx, order, now);
    }
  }

  private async grantStartup(
    tx: Tx,
    order: { id: bigint; userId: bigint; payAmountFen: number },
    now: Date,
  ): Promise<void> {
    const base = BigInt(order.payAmountFen);
    const invite = await tx.inviteTreeNode.findUnique({ where: { userId: order.userId } });
    if (invite?.parentUserId) {
      await this.credits.creditSplit(tx, {
        userId: invite.parentUserId,
        amountFen: applyBps(base, this.locked.startupSalesRatioBps),
        split: this.locked.startupAwardSplit,
        bizType: SOURCE_STARTUP_SALES,
        bizId: orderBiz(order.id),
        sourceCode: SOURCE_STARTUP_SALES,
        orderId: order.id,
        layer: 1,
        now,
      });
    }

    let current = order.userId;
    for (let layer = 1; layer <= STARTUP_LAYER_MAX; layer += 1) {
      const node = await tx.marketTreeNode.findUnique({ where: { userId: current } });
      if (!node?.parentUserId) {
        break;
      }
      const recipientId = node.parentUserId;
      if (await this.startupLayerQualifies(tx, recipientId, layer)) {
        await this.credits.creditSplit(tx, {
          userId: recipientId,
          amountFen: applyBps(base, this.locked.startupPointRatioBps),
          split: this.locked.startupAwardSplit,
          bizType: SOURCE_STARTUP_POINTS,
          bizId: layerBiz(order.id, layer),
          sourceCode: SOURCE_STARTUP_POINTS,
          orderId: order.id,
          layer,
          now,
        });
      }
      current = recipientId;
    }
  }

  private async grantMall(
    tx: Tx,
    order: { id: bigint; userId: bigint; pvFen: number },
    now: Date,
  ): Promise<void> {
    const base = BigInt(order.pvFen);
    let current = order.userId;
    for (let layer = 1; layer <= MALL_LAYER_MAX; layer += 1) {
      const invite = await tx.inviteTreeNode.findUnique({ where: { userId: current } });
      if (!invite?.parentUserId) {
        break;
      }
      const recipientId = invite.parentUserId;
      if (layer === 1) {
        await this.credits.creditSplit(tx, {
          userId: recipientId,
          amountFen: applyBps(base, this.locked.mallSalesRatioBps),
          split: this.locked.mallAwardSplit,
          bizType: SOURCE_MALL_SALES,
          bizId: orderBiz(order.id),
          sourceCode: SOURCE_MALL_SALES,
          orderId: order.id,
          layer: 1,
          now,
        });
      } else {
        await this.credits.creditSplit(tx, {
          userId: recipientId,
          amountFen: applyBps(base, this.locked.mallPointRatioBps),
          split: this.locked.mallAwardSplit,
          bizType: SOURCE_MALL_POINTS,
          bizId: layerBiz(order.id, layer),
          sourceCode: SOURCE_MALL_POINTS,
          orderId: order.id,
          layer,
          now,
        });
      }
      current = recipientId;
    }
  }

  /**
   * 1–4 层不设门槛。5–8 层要有至少 3 笔创业子单、合计至少 3N，以及至少 3 名邀请直接会员。
   * 9–12 层把 3 换成 5。某一层不够就跳过，继续往上。13 层及以上不发。
   * 直接会员指邀请关系下已经入座的人。
   */
  private async startupLayerQualifies(tx: Tx, userId: bigint, layer: number): Promise<boolean> {
    if (layer <= 4) {
      return true;
    }
    if (layer > STARTUP_LAYER_MAX) {
      return false;
    }
    const need = layer <= 8 ? 3 : 5;
    const volume = await this.startupVolume(tx, userId);
    const invites = await this.directInviteMembers(tx, userId);
    const threshold = BigInt(this.locked.startupZoneUnitPriceFen) * BigInt(need);
    return volume.count >= need && volume.totalFen >= threshold && invites >= need;
  }

  private async startupVolume(
    tx: Tx,
    userId: bigint,
  ): Promise<{ count: number; totalFen: bigint }> {
    const rows = await tx.startupSubOrder.findMany({ where: { userId } });
    let totalFen = 0n;
    for (const row of rows) {
      totalFen += BigInt(row.amountFen);
    }
    return { count: rows.length, totalFen };
  }

  private async directInviteMembers(tx: Tx, userId: bigint): Promise<number> {
    const children = await tx.inviteTreeNode.findMany({ where: { parentUserId: userId } });
    if (children.length === 0) {
      return 0;
    }
    const users = await tx.user.findMany({
      where: { id: { in: children.map((child) => child.userId) } },
    });
    return users.filter((user) => user.member).length;
  }
}

function orderBiz(orderId: bigint): string {
  return `order:${orderId.toString()}`;
}

function layerBiz(orderId: bigint, layer: number): string {
  return `order:${orderId.toString()}:layer:${layer}`;
}
