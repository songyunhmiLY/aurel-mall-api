import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isWalletType } from './wallet.constants';
import { WalletService } from './wallet.service';

export interface WalletHoldView {
  id: bigint;
  orderId: bigint;
  walletType: string;
  amountFen: bigint;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransferAdminView {
  id: bigint;
  payerUserId: bigint;
  payerNickname: string;
  payeeUserId: bigint;
  payeeNickname: string;
  amountFen: bigint;
  createdAt: Date;
}

/**
 * 管理端查看任意会员的三个账户、冻结、流水，以及会员之间的消费账户划转。
 */
@Injectable()
export class WalletAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  async balances(userId: bigint) {
    await this.requireUser(userId);
    return this.wallet.getBalances(userId);
  }

  async holds(
    userId: bigint,
    status: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ items: WalletHoldView[]; total: number; page: number; pageSize: number }> {
    await this.requireUser(userId);
    const where: Prisma.WalletHoldWhereInput = { userId };
    if (status !== undefined && status !== '') {
      where.status = status;
    }
    const [total, rows] = await Promise.all([
      this.prisma.walletHold.count({ where }),
      this.prisma.walletHold.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        walletType: row.walletType,
        amountFen: row.amountFen,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async ledger(userId: bigint, walletType: string, page: number, pageSize: number) {
    await this.requireUser(userId);
    if (!isWalletType(walletType)) {
      throw new BadRequestException('钱包类型不正确');
    }
    return this.wallet.listLedger(userId, walletType, page, pageSize);
  }

  async transfers(query: {
    payerId?: bigint;
    payeeId?: bigint;
    page: number;
    pageSize: number;
  }): Promise<{ items: TransferAdminView[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.ConsumptionTransferWhereInput = {};
    if (query.payerId !== undefined) {
      where.payerUserId = query.payerId;
    }
    if (query.payeeId !== undefined) {
      where.payeeUserId = query.payeeId;
    }
    const [total, rows] = await Promise.all([
      this.prisma.consumptionTransfer.count({ where }),
      this.prisma.consumptionTransfer.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const ids = rows.flatMap((row) => [row.payerUserId, row.payeeUserId]);
    const users =
      ids.length === 0 ? [] : await this.prisma.user.findMany({ where: { id: { in: ids } } });
    const nicknames = new Map(users.map((user) => [user.id.toString(), user.nickname]));
    return {
      items: rows.map((row) => ({
        id: row.id,
        payerUserId: row.payerUserId,
        payerNickname: nicknames.get(row.payerUserId.toString()) ?? '会员',
        payeeUserId: row.payeeUserId,
        payeeNickname: nicknames.get(row.payeeUserId.toString()) ?? '会员',
        amountFen: row.amountFen,
        createdAt: row.createdAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async requireUser(userId: bigint): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
  }
}
