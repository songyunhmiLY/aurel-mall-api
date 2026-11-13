import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface FilingSettlementView {
  triggerSequence: number;
  beneficiaryFilingId: bigint;
  beneficiaryUserId: bigint;
  pointsFen: bigint;
  withdrawableFen: bigint;
  unitPriceFen: number;
  withdrawalRatioBps: number;
  settledAt: Date;
}

export interface FilingView {
  id: bigint;
  filingNo: string;
  userId: bigint;
  nickname: string;
  orderId: bigint | null;
  subOrderId: bigint | null;
  sequence: number | null;
  bizDate: string | null;
  status: string;
  amountFen: number;
  filedAt: Date | null;
  settledAt: Date | null;
  settlement: FilingSettlementView | null;
  triggeredSettlement: FilingSettlementView | null;
}

export interface FilingPage {
  items: FilingView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 管理端查询报单和全网公排。序号是完成报单的全局顺序。
 * 序号为 5 的倍数时，triggeredSettlement 是当时发给序号 k 的幸运返还。
 * settlement 是这一笔自己作为第 k 单领到的返还。
 */
@Injectable()
export class FilingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: {
    userId?: bigint;
    bizDate?: string;
    sequence?: number;
    page: number;
    pageSize: number;
  }): Promise<FilingPage> {
    const where: Prisma.FilingWhereInput = {};
    if (query.userId !== undefined) {
      where.userId = query.userId;
    }
    if (query.bizDate !== undefined) {
      where.bizDate = query.bizDate;
    }
    if (query.sequence !== undefined) {
      where.sequence = query.sequence;
    }
    const [total, rows] = await Promise.all([
      this.prisma.filing.count({ where }),
      this.prisma.filing.findMany({
        where,
        orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: await this.decorate(rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: bigint): Promise<FilingView> {
    const row = await this.prisma.filing.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('报单不存在');
    }
    const [view] = await this.decorate([row]);
    if (!view) {
      throw new NotFoundException('报单不存在');
    }
    return view;
  }

  async listSettlements(query: { userId?: bigint; page: number; pageSize: number }): Promise<{
    items: FilingSettlementView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where: Prisma.FilingSettlementWhereInput = {};
    if (query.userId !== undefined) {
      where.beneficiaryUserId = query.userId;
    }
    const [total, rows] = await Promise.all([
      this.prisma.filingSettlement.count({ where }),
      this.prisma.filingSettlement.findMany({
        where,
        orderBy: [{ triggerSequence: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map(toSettlement),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async decorate(
    rows: Array<{
      id: bigint;
      filingNo: string;
      userId: bigint;
      orderId: bigint | null;
      subOrderId: bigint | null;
      sequence: number | null;
      bizDate: string | null;
      status: string;
      amountFen: number;
      filedAt: Date | null;
      settledAt: Date | null;
    }>,
  ): Promise<FilingView[]> {
    if (rows.length === 0) {
      return [];
    }
    const userIds = rows.map((row) => row.userId);
    const sequences = rows
      .map((row) => row.sequence)
      .filter((value): value is number => value !== null);
    const triggers = sequences.filter((value) => value % 5 === 0);
    const [users, received, triggered] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } } }),
      this.prisma.filingSettlement.findMany({
        where: { beneficiaryFilingId: { in: rows.map((row) => row.id) } },
      }),
      triggers.length === 0
        ? Promise.resolve([])
        : this.prisma.filingSettlement.findMany({ where: { triggerSequence: { in: triggers } } }),
    ]);
    const nicknames = new Map(users.map((user) => [user.id.toString(), user.nickname]));
    const byBeneficiary = new Map(received.map((row) => [row.beneficiaryFilingId.toString(), row]));
    const byTrigger = new Map(triggered.map((row) => [row.triggerSequence, row]));
    return rows.map((row) => ({
      id: row.id,
      filingNo: row.filingNo,
      userId: row.userId,
      nickname: nicknames.get(row.userId.toString()) ?? '会员',
      orderId: row.orderId,
      subOrderId: row.subOrderId,
      sequence: row.sequence,
      bizDate: row.bizDate,
      status: row.status,
      amountFen: row.amountFen,
      filedAt: row.filedAt,
      settledAt: row.settledAt,
      settlement: toSettlementOrNull(byBeneficiary.get(row.id.toString())),
      triggeredSettlement:
        row.sequence !== null && row.sequence % 5 === 0
          ? toSettlementOrNull(byTrigger.get(row.sequence))
          : null,
    }));
  }
}

function toSettlementOrNull(
  row:
    | {
        triggerSequence: number;
        beneficiaryFilingId: bigint;
        beneficiaryUserId: bigint;
        pointsFen: bigint;
        withdrawableFen: bigint;
        unitPriceFen: number;
        withdrawalRatioBps: number;
        settledAt: Date;
      }
    | undefined,
): FilingSettlementView | null {
  return row ? toSettlement(row) : null;
}

function toSettlement(row: {
  triggerSequence: number;
  beneficiaryFilingId: bigint;
  beneficiaryUserId: bigint;
  pointsFen: bigint;
  withdrawableFen: bigint;
  unitPriceFen: number;
  withdrawalRatioBps: number;
  settledAt: Date;
}): FilingSettlementView {
  return {
    triggerSequence: row.triggerSequence,
    beneficiaryFilingId: row.beneficiaryFilingId,
    beneficiaryUserId: row.beneficiaryUserId,
    pointsFen: row.pointsFen,
    withdrawableFen: row.withdrawableFen,
    unitPriceFen: row.unitPriceFen,
    withdrawalRatioBps: row.withdrawalRatioBps,
    settledAt: row.settledAt,
  };
}
