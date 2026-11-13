import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, WalletLedgerEntry, WithdrawalDisplaySource } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  LEDGER_CREDIT,
  WALLET_WITHDRAWABLE,
  WITHDRAWAL_DISPLAY_SOURCES,
  isWithdrawalDisplaySource,
} from './wallet.constants';
import { WalletService, type WalletLedgerPage } from './wallet.service';

export interface DisplaySourceView {
  sourceCode: string;
  displayName: string;
}

export interface WithdrawalCategoryView {
  displayName: string;
  totalFen: bigint;
  sourceCodes: string[];
}

export interface WithdrawalCategoryPage {
  balanceFen: bigint;
  frozenFen: bigint;
  availableFen: bigint;
  categories: WithdrawalCategoryView[];
}

@Injectable()
export class DisplayNameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
  ) {}

  async listSources(): Promise<{ items: DisplaySourceView[] }> {
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.ensureSources(tx, now, null);
    });
    return { items: await this.readSources() };
  }

  async updateSources(
    items: Array<{ sourceCode: string; displayName: string }>,
    adminId: bigint,
  ): Promise<{ items: DisplaySourceView[] }> {
    const normalized = normalizeUpdates(items);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.ensureSources(tx, now, null);
      for (const item of normalized) {
        await tx.withdrawalDisplaySource.update({
          where: { sourceCode: item.sourceCode },
          data: { displayName: item.displayName, updatedAt: now, updatedByAdminId: adminId },
        });
      }
    });
    return { items: await this.readSources() };
  }

  async categoriesForUser(userId: bigint): Promise<WithdrawalCategoryPage> {
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.ensureSources(tx, now, null);
    });
    const balances = await this.wallet.getBalances(userId);
    const sources = await this.prisma.withdrawalDisplaySource.findMany();
    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: { userId, walletType: WALLET_WITHDRAWABLE },
    });
    return {
      balanceFen: balances.withdrawable.balanceFen,
      frozenFen: balances.withdrawable.frozenFen,
      availableFen: balances.withdrawable.availableFen,
      categories: groupCategories(sources, entries),
    };
  }

  async categoryLedger(
    userId: bigint,
    displayName: string,
    page: number,
    pageSize: number,
  ): Promise<WalletLedgerPage> {
    const name = displayName.trim();
    if (name.length < 1 || name.length > 64) {
      throw new BadRequestException('分类名称不正确');
    }
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.ensureSources(tx, now, null);
    });
    const sources = await this.prisma.withdrawalDisplaySource.findMany({
      where: { displayName: name },
    });
    if (sources.length === 0) {
      throw new NotFoundException('分类不存在');
    }
    const sourceCodes = sources.map((row) => row.sourceCode);
    const where = {
      userId,
      walletType: WALLET_WITHDRAWABLE,
      sourceCode: { in: sourceCodes },
    };
    const [total, rows] = await Promise.all([
      this.prisma.walletLedgerEntry.count({ where }),
      this.prisma.walletLedgerEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        walletType: row.walletType,
        direction: row.direction,
        amountFen: row.amountFen,
        balanceAfterFen: row.balanceAfterFen,
        bizType: row.bizType,
        bizId: row.bizId,
        sourceCode: row.sourceCode,
        occurredAt: row.occurredAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  private async readSources(): Promise<DisplaySourceView[]> {
    const rows = await this.prisma.withdrawalDisplaySource.findMany();
    const byCode = new Map(rows.map((row) => [row.sourceCode, row.displayName]));
    return WITHDRAWAL_DISPLAY_SOURCES.map((sourceCode) => ({
      sourceCode,
      displayName: byCode.get(sourceCode) ?? sourceCode,
    }));
  }

  private async ensureSources(
    tx: Prisma.TransactionClient,
    now: Date,
    adminId: bigint | null,
  ): Promise<void> {
    for (const sourceCode of WITHDRAWAL_DISPLAY_SOURCES) {
      const existing = await tx.withdrawalDisplaySource.findUnique({ where: { sourceCode } });
      if (existing) {
        continue;
      }
      try {
        await tx.withdrawalDisplaySource.create({
          data: {
            sourceCode,
            displayName: sourceCode,
            updatedAt: now,
            updatedByAdminId: adminId,
          },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    }
  }
}

function normalizeUpdates(
  items: Array<{ sourceCode: string; displayName: string }>,
): Array<{ sourceCode: string; displayName: string }> {
  if (items.length < 1) {
    throw new BadRequestException('请填写显示名');
  }
  const seen = new Set<string>();
  return items.map((item) => {
    if (!isWithdrawalDisplaySource(item.sourceCode) || seen.has(item.sourceCode)) {
      throw new BadRequestException(seen.has(item.sourceCode) ? '来源重复' : '提现分类来源不正确');
    }
    seen.add(item.sourceCode);
    const displayName = item.displayName.trim();
    if (displayName.length < 1 || displayName.length > 64) {
      throw new BadRequestException('显示名不正确');
    }
    return { sourceCode: item.sourceCode, displayName };
  });
}

function groupCategories(
  sources: WithdrawalDisplaySource[],
  entries: WalletLedgerEntry[],
): WithdrawalCategoryView[] {
  const groups = new Map<string, WithdrawalCategoryView>();
  const nameByCode = new Map<string, string>();
  for (const source of sources) {
    if (!isWithdrawalDisplaySource(source.sourceCode)) {
      continue;
    }
    nameByCode.set(source.sourceCode, source.displayName);
    const current = groups.get(source.displayName);
    if (current) {
      current.sourceCodes.push(source.sourceCode);
      continue;
    }
    groups.set(source.displayName, {
      displayName: source.displayName,
      totalFen: 0n,
      sourceCodes: [source.sourceCode],
    });
  }
  for (const entry of entries) {
    if (!entry.sourceCode) {
      continue;
    }
    const displayName = nameByCode.get(entry.sourceCode);
    const group = displayName ? groups.get(displayName) : undefined;
    if (!group) {
      continue;
    }
    const signed = entry.direction === LEDGER_CREDIT ? entry.amountFen : -entry.amountFen;
    group.totalFen += signed;
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      sourceCodes: [...group.sourceCodes].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
