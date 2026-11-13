import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LEDGER_CREDIT } from '../../wallet/wallet.constants';

const AWARD_TYPES = ['startup_sales', 'startup_points', 'mall_sales', 'mall_points'] as const;

export interface AwardWalletLine {
  walletType: string;
  amountFen: bigint;
  sourceCode: string | null;
}

export interface AwardView {
  id: bigint;
  userId: bigint;
  nickname: string;
  rewardType: string;
  orderId: bigint | null;
  layer: number | null;
  amountFen: bigint;
  occurredAt: Date;
  wallets: AwardWalletLine[];
}

export interface AwardPage {
  items: AwardView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 管理端按订单、层和收款人查询创业专区与商城的销售奖、见点奖。
 * 销售奖的层记为 1，表示直接邀请人。创业专区见点奖的层是市场上级数。
 */
@Injectable()
export class AwardAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: {
    userId?: bigint;
    orderId?: bigint;
    rewardType?: string;
    layer?: number;
    page: number;
    pageSize: number;
  }): Promise<AwardPage> {
    const where: Prisma.RewardLedgerEntryWhereInput = {
      rewardType: { in: [...AWARD_TYPES] },
    };
    if (query.userId !== undefined) {
      where.userId = query.userId;
    }
    if (query.orderId !== undefined) {
      where.orderId = query.orderId;
    }
    if (query.rewardType !== undefined) {
      if (!(AWARD_TYPES as readonly string[]).includes(query.rewardType)) {
        throw new BadRequestException('奖励类型不正确');
      }
      where.rewardType = query.rewardType;
    }
    if (query.layer !== undefined) {
      where.layer = query.layer;
    }
    const [total, rows] = await Promise.all([
      this.prisma.rewardLedgerEntry.count({ where }),
      this.prisma.rewardLedgerEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    if (rows.length === 0) {
      return { items: [], total, page: query.page, pageSize: query.pageSize };
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.userId) } },
    });
    const nicknames = new Map(users.map((user) => [user.id.toString(), user.nickname]));
    const ledgers = await this.prisma.walletLedgerEntry.findMany({
      where: {
        direction: LEDGER_CREDIT,
        bizType: { in: [...AWARD_TYPES] },
        bizId: { in: rows.map((row) => row.bizId) },
      },
    });
    const items = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      nickname: nicknames.get(row.userId.toString()) ?? '会员',
      rewardType: row.rewardType,
      orderId: row.orderId,
      layer: row.layer,
      amountFen: row.amountFen,
      occurredAt: row.occurredAt,
      wallets: ledgers
        .filter(
          (entry) =>
            entry.userId === row.userId &&
            entry.bizType === row.bizType &&
            entry.bizId === row.bizId,
        )
        .map((entry) => ({
          walletType: entry.walletType,
          amountFen: entry.amountFen,
          sourceCode: entry.sourceCode,
        })),
    }));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
