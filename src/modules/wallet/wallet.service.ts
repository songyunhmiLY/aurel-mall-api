import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Prisma, WalletAccount } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  HOLD_CAPTURED,
  HOLD_HELD,
  HOLD_RELEASED,
  LEDGER_CREDIT,
  LEDGER_DEBIT,
  LEDGER_ORDER_PAYMENT,
  WALLET_TYPES,
  type WalletType,
  isWalletType,
} from './wallet.constants';

export interface WalletBalanceView {
  balanceFen: bigint;
  frozenFen: bigint;
  availableFen: bigint;
}

export interface WalletBalancesView {
  points: WalletBalanceView;
  withdrawable: WalletBalanceView;
  consumption: WalletBalanceView;
}

type Tx = Prisma.TransactionClient;

/**
 * 三个账户：积分、可提现、消费。
 * 本阶段只支持支付扣款和余额查询。不做账户互转、提现申请或提现分类。
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async getBalances(userId: bigint): Promise<WalletBalancesView> {
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.ensureAccounts(tx, userId, now);
    });
    const rows = await this.prisma.walletAccount.findMany({ where: { userId } });
    return toBalances(rows);
  }

  /**
   * 给账户加款并记流水。支付不调用它。测试和以后的奖励入账用。
   * 不提供用户之间或本人三个账户之间的划转接口。
   */
  async credit(input: {
    userId: bigint;
    walletType: string;
    amountFen: bigint;
    bizType: string;
    bizId: string;
  }): Promise<void> {
    const walletType = parseWalletType(input.walletType);
    if (input.amountFen <= 0n) {
      throw new BadRequestException('金额不正确');
    }
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.lockAll(tx, input.userId, now);
      const account = await this.requireAccount(tx, input.userId, walletType);
      const balanceFen = account.balanceFen + input.amountFen;
      await tx.walletAccount.update({
        where: { id: account.id },
        data: { balanceFen, updatedAt: now },
      });
      await tx.walletLedgerEntry.create({
        data: {
          accountId: account.id,
          userId: input.userId,
          walletType,
          direction: LEDGER_CREDIT,
          amountFen: input.amountFen,
          balanceAfterFen: balanceFen,
          bizType: input.bizType,
          bizId: input.bizId,
          occurredAt: now,
          createdAt: now,
        },
      });
    });
  }

  async lockAll(tx: Tx, userId: bigint, now: Date): Promise<void> {
    await this.ensureAccounts(tx, userId, now);
    for (const walletType of WALLET_TYPES) {
      await tx.$queryRaw`
        SELECT id FROM wallet_accounts
        WHERE user_id = ${userId} AND wallet_type = ${walletType}
        FOR UPDATE
      `;
    }
  }

  async availableFen(tx: Tx, userId: bigint, walletType: WalletType): Promise<bigint> {
    const account = await this.requireAccount(tx, userId, walletType);
    return account.balanceFen - account.frozenFen;
  }

  async hold(
    tx: Tx,
    userId: bigint,
    walletType: WalletType,
    amountFen: bigint,
    orderId: bigint,
    now: Date,
  ): Promise<void> {
    if (amountFen <= 0n) {
      return;
    }
    const account = await this.requireAccount(tx, userId, walletType);
    const available = account.balanceFen - account.frozenFen;
    if (available < amountFen) {
      throw new ConflictException('余额不足');
    }
    await tx.walletAccount.update({
      where: { id: account.id },
      data: { frozenFen: account.frozenFen + amountFen, updatedAt: now },
    });
    const existing = await tx.walletHold.findFirst({ where: { orderId, walletType } });
    if (!existing) {
      await tx.walletHold.create({
        data: {
          orderId,
          userId,
          walletType,
          amountFen,
          status: HOLD_HELD,
          createdAt: now,
          updatedAt: now,
        },
      });
      return;
    }
    if (existing.status !== HOLD_RELEASED) {
      throw new ConflictException('余额不足');
    }
    await tx.walletHold.update({
      where: { id: existing.id },
      data: { amountFen, status: HOLD_HELD, updatedAt: now },
    });
  }

  /** 把仍处于 held 的冻结扣成实付，并写借记流水。 */
  async captureHolds(tx: Tx, orderId: bigint, now: Date): Promise<void> {
    const preview = await tx.walletHold.findFirst({ where: { orderId, status: HOLD_HELD } });
    if (!preview) {
      return;
    }
    await this.lockAll(tx, preview.userId, now);
    const holds = await tx.walletHold.findMany({ where: { orderId, status: HOLD_HELD } });
    const ordered = [...holds].sort((left, right) =>
      left.walletType.localeCompare(right.walletType),
    );
    for (const hold of ordered) {
      if (!isWalletType(hold.walletType)) {
        throw new InternalServerErrorException('钱包账户不存在');
      }
      const account = await this.requireAccount(tx, hold.userId, hold.walletType);
      if (account.frozenFen < hold.amountFen || account.balanceFen < hold.amountFen) {
        throw new ConflictException('余额不足');
      }
      const balanceFen = account.balanceFen - hold.amountFen;
      await tx.walletAccount.update({
        where: { id: account.id },
        data: {
          balanceFen,
          frozenFen: account.frozenFen - hold.amountFen,
          updatedAt: now,
        },
      });
      await this.writeDebit(
        tx,
        account,
        hold.userId,
        hold.walletType,
        hold.amountFen,
        balanceFen,
        orderId,
        now,
      );
      await tx.walletHold.update({
        where: { id: hold.id },
        data: { status: HOLD_CAPTURED, updatedAt: now },
      });
    }
  }

  /** 冻结已经释放之后，按订单上记下的金额直接扣可用余额。 */
  async debit(
    tx: Tx,
    userId: bigint,
    walletType: WalletType,
    amountFen: bigint,
    orderId: bigint,
    now: Date,
  ): Promise<void> {
    if (amountFen <= 0n) {
      return;
    }
    const account = await this.requireAccount(tx, userId, walletType);
    const available = account.balanceFen - account.frozenFen;
    if (available < amountFen || account.balanceFen < amountFen) {
      throw new ConflictException('余额不足');
    }
    const balanceFen = account.balanceFen - amountFen;
    await tx.walletAccount.update({
      where: { id: account.id },
      data: { balanceFen, updatedAt: now },
    });
    await this.writeDebit(tx, account, userId, walletType, amountFen, balanceFen, orderId, now);
  }

  async releaseHolds(tx: Tx, orderId: bigint, now: Date): Promise<void> {
    const preview = await tx.walletHold.findFirst({ where: { orderId, status: HOLD_HELD } });
    if (!preview) {
      return;
    }
    await this.lockAll(tx, preview.userId, now);
    const holds = await tx.walletHold.findMany({ where: { orderId, status: HOLD_HELD } });
    const ordered = [...holds].sort((left, right) =>
      left.walletType.localeCompare(right.walletType),
    );
    for (const hold of ordered) {
      if (!isWalletType(hold.walletType)) {
        throw new InternalServerErrorException('钱包账户不存在');
      }
      const account = await this.requireAccount(tx, hold.userId, hold.walletType);
      if (account.frozenFen < hold.amountFen) {
        throw new ConflictException('余额不足');
      }
      await tx.walletAccount.update({
        where: { id: account.id },
        data: { frozenFen: account.frozenFen - hold.amountFen, updatedAt: now },
      });
      await tx.walletHold.update({
        where: { id: hold.id },
        data: { status: HOLD_RELEASED, updatedAt: now },
      });
    }
  }

  private async writeDebit(
    tx: Tx,
    account: WalletAccount,
    userId: bigint,
    walletType: WalletType,
    amountFen: bigint,
    balanceFen: bigint,
    orderId: bigint,
    now: Date,
  ): Promise<void> {
    await tx.walletLedgerEntry.create({
      data: {
        accountId: account.id,
        userId,
        walletType,
        direction: LEDGER_DEBIT,
        amountFen,
        balanceAfterFen: balanceFen,
        bizType: LEDGER_ORDER_PAYMENT,
        bizId: orderId.toString(),
        occurredAt: now,
        createdAt: now,
      },
    });
  }

  private async ensureAccounts(tx: Tx, userId: bigint, now: Date): Promise<void> {
    for (const walletType of WALLET_TYPES) {
      const existing = await tx.walletAccount.findFirst({ where: { userId, walletType } });
      if (existing) {
        continue;
      }
      try {
        await tx.walletAccount.create({
          data: {
            userId,
            walletType,
            balanceFen: 0n,
            frozenFen: 0n,
            updatedAt: now,
          },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    }
  }

  private async requireAccount(
    tx: Tx,
    userId: bigint,
    walletType: WalletType,
  ): Promise<WalletAccount> {
    const account = await tx.walletAccount.findFirst({ where: { userId, walletType } });
    if (!account) {
      throw new InternalServerErrorException('钱包账户不存在');
    }
    return account;
  }
}

function parseWalletType(value: string): WalletType {
  if (!isWalletType(value)) {
    throw new BadRequestException('钱包类型不正确');
  }
  return value;
}

function toBalances(rows: WalletAccount[]): WalletBalancesView {
  const byType = new Map(rows.map((row) => [row.walletType, row]));
  return {
    points: one(byType.get('points')),
    withdrawable: one(byType.get('withdrawable')),
    consumption: one(byType.get('consumption')),
  };
}

function one(row: WalletAccount | undefined): WalletBalanceView {
  const balanceFen = row?.balanceFen ?? 0n;
  const frozenFen = row?.frozenFen ?? 0n;
  return {
    balanceFen,
    frozenFen,
    availableFen: balanceFen - frozenFen,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
