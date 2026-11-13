import { Injectable } from '@nestjs/common';
import type { MarketTreeNode, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { ORDER_PAID, ORDER_SHIPPED } from '../orders/order.constants';

type Db = Prisma.TransactionClient | PrismaService;

const PAID_STATUSES = [ORDER_PAID, ORDER_SHIPPED];

export interface MarketNodeRow {
  id: bigint;
  userId: bigint;
  parentUserId: bigint | null;
  depth: number;
  path: string;
  placedAt: Date;
}

/**
 * 市场业绩只统计创业专区已支付订单的应付金额（含运费），沿直接下级及其下级累加。
 * 商城 PV 另计，供职位分红使用。这里不出现给会员看的文案。
 */
@Injectable()
export class MarketPerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async loadNodes(db: Db = this.prisma): Promise<MarketNodeRow[]> {
    const rows = await db.marketTreeNode.findMany();
    return rows.map((row) => toNode(row));
  }

  directChildren(nodes: MarketNodeRow[], userId: bigint): MarketNodeRow[] {
    return nodes
      .filter((node) => node.parentUserId === userId)
      .sort((left, right) => comparePlaced(left, right));
  }

  subtreeUserIds(nodes: MarketNodeRow[], market: MarketNodeRow): bigint[] {
    const prefix = market.path;
    return nodes.filter((node) => node.path.startsWith(prefix)).map((node) => node.userId);
  }

  async startupPaidByUser(
    userIds: bigint[],
    from: Date,
    until: Date,
    db: Db = this.prisma,
  ): Promise<Map<string, bigint>> {
    return this.sumByUser(PRODUCT_ZONE_STARTUP, 'payAmountFen', userIds, from, until, db);
  }

  async mallPvByUser(
    userIds: bigint[],
    from: Date,
    until: Date,
    db: Db = this.prisma,
  ): Promise<Map<string, bigint>> {
    return this.sumByUser(PRODUCT_ZONE_MALL, 'pvFen', userIds, from, until, db);
  }

  /** 全平台商城 PV。退款不改订单 PV，已结束月份再算结果不变。 */
  async platformMallPv(from: Date, until: Date, db: Db = this.prisma): Promise<bigint> {
    const orders = await db.order.findMany({
      where: {
        zone: PRODUCT_ZONE_MALL,
        status: { in: PAID_STATUSES },
        paidAt: { gte: from, lt: until },
      },
    });
    let total = 0n;
    for (const order of orders) {
      total += BigInt(order.pvFen);
    }
    return total;
  }

  sumUsers(amounts: Map<string, bigint>, userIds: bigint[]): bigint {
    let total = 0n;
    for (const userId of userIds) {
      total += amounts.get(userId.toString()) ?? 0n;
    }
    return total;
  }

  private async sumByUser(
    zone: string,
    field: 'payAmountFen' | 'pvFen',
    userIds: bigint[],
    from: Date,
    until: Date,
    db: Db,
  ): Promise<Map<string, bigint>> {
    const totals = new Map<string, bigint>();
    if (userIds.length === 0) {
      return totals;
    }
    const chunkSize = 500;
    for (let offset = 0; offset < userIds.length; offset += chunkSize) {
      const chunk = userIds.slice(offset, offset + chunkSize);
      const orders = await db.order.findMany({
        where: {
          zone,
          status: { in: PAID_STATUSES },
          userId: { in: chunk },
          paidAt: { gte: from, lt: until },
        },
      });
      for (const order of orders) {
        const key = order.userId.toString();
        const amount = BigInt(order[field]);
        totals.set(key, (totals.get(key) ?? 0n) + amount);
      }
    }
    return totals;
  }
}

function toNode(row: MarketTreeNode): MarketNodeRow {
  return {
    id: row.id,
    userId: row.userId,
    parentUserId: row.parentUserId,
    depth: row.depth,
    path: row.path,
    placedAt: row.placedAt,
  };
}

function comparePlaced(left: MarketNodeRow, right: MarketNodeRow): number {
  const time = left.placedAt.getTime() - right.placedAt.getTime();
  if (time !== 0) {
    return time;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}
