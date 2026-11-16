import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, WithdrawalApplication, WithdrawalSettlement } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { enqueueNotify } from '../../common/notify/notify-buffer';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { KycService } from '../users/kyc.service';
import { USER_STATUS_ACTIVE } from '../../common/auth/user-status';
import { CashLedgerService } from './cash-ledger.service';
import {
  CASH_WITHDRAWAL_PAYOUT,
  LEDGER_WITHDRAWAL_PAYOUT,
  MIN_WITHDRAWAL_FEN,
  WALLET_WITHDRAWABLE,
  WITHDRAWAL_PAID,
  WITHDRAWAL_PENDING,
  WITHDRAWAL_REJECTED,
} from './wallet.constants';
import { WalletService } from './wallet.service';

const REFUND_PENDING = 'pending';

export interface WithdrawalSettlementView {
  outcome: string;
  amountFen: bigint;
  feeFen: bigint | null;
  payoutFen: bigint | null;
  adminId: bigint;
  settledAt: string;
}

export interface WithdrawalView {
  id: bigint;
  userId: bigint;
  amountFen: bigint;
  /** 按当前锁定费率算出的手续费。财务据此算线下应打款金额，实际以打款确认时为准。 */
  feePreviewFen: bigint;
  /** 按当前锁定费率算出的应打款金额 = 申请金额 − 手续费。 */
  payoutPreviewFen: bigint;
  status: string;
  accountName: string;
  bankName: string;
  accountNo: string;
  branchName: string;
  appliedAt: string;
  settlement: WithdrawalSettlementView | null;
}

export interface WithdrawalPage {
  items: WithdrawalView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 会员提现。申请时冻结可提现金额，驳回则解冻。
 * 打款金额 = 申请金额 ×（1 − 打款当时的锁定手续费率），向下取整到分。
 * 财务按这个金额在线下完成转账，再回系统标记打款完成，系统发事件通知；系统不自动支付。
 * 有未结算的商城退款时不能申请。
 */
@Injectable()
export class WithdrawalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    private readonly kyc: KycService,
    private readonly cash: CashLedgerService,
    @Inject(LOCKED_RUNTIME_CONFIG)
    private readonly fees: Pick<LockedRuntimeConfig, 'withdrawalFeeBps'>,
  ) {}

  async apply(userId: bigint, amountFen: bigint): Promise<WithdrawalView> {
    if (amountFen < MIN_WITHDRAWAL_FEN) {
      throw new BadRequestException('提现金额不能低于 100 元');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== USER_STATUS_ACTIVE) {
      throw new ForbiddenException('非会员不能提现');
    }
    if (!user.member) {
      throw new ForbiddenException('非会员不能提现');
    }
    if (!(await this.kyc.isVerified(userId))) {
      throw new ForbiddenException('请先完成实名认证');
    }
    const bank = await this.prisma.userBankAccount.findUnique({ where: { userId } });
    if (!bank) {
      throw new BadRequestException('请先设置收款账户');
    }
    const now = await this.clock.now();
    const created = await this.prisma.$transaction(async (tx) => {
      await this.wallet.lockUser(tx, userId);
      const openRefund = await tx.orderRefund.findFirst({
        where: { userId, status: REFUND_PENDING },
      });
      if (openRefund) {
        throw new ConflictException('有未结算的商城退款，不能提现');
      }
      await this.wallet.lockAll(tx, userId, now);
      await this.wallet.freezeAmount(tx, userId, WALLET_WITHDRAWABLE, amountFen, now);
      const created = await tx.withdrawalApplication.create({
        data: {
          userId,
          amountFen,
          status: WITHDRAWAL_PENDING,
          accountName: bank.accountName,
          bankName: bank.bankName,
          accountNo: bank.accountNo,
          branchName: bank.branchName,
          appliedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      enqueueNotify({
        type: 'withdrawal_outcome',
        userId,
        status: 'pending',
        amountFen,
        payoutFen: 0n,
        orderNo: created.id.toString(),
        occurredAt: now,
      });
      return created;
    });
    return toView(created, null, this.fees.withdrawalFeeBps);
  }

  async listForUser(userId: bigint, page: number, pageSize: number): Promise<WithdrawalPage> {
    return this.list({ userId }, page, pageSize);
  }

  async getForUser(userId: bigint, id: bigint): Promise<WithdrawalView> {
    const row = await this.prisma.withdrawalApplication.findFirst({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException('提现申请不存在');
    }
    const settlement = await this.prisma.withdrawalSettlement.findUnique({
      where: { applicationId: row.id },
    });
    return toView(row, settlement, this.fees.withdrawalFeeBps);
  }

  async listAdmin(query: {
    status?: string;
    userId?: bigint;
    page: number;
    pageSize: number;
  }): Promise<WithdrawalPage> {
    if (
      query.status !== undefined &&
      query.status !== WITHDRAWAL_PENDING &&
      query.status !== WITHDRAWAL_REJECTED &&
      query.status !== WITHDRAWAL_PAID
    ) {
      throw new BadRequestException('状态不正确');
    }
    return this.list(
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
      },
      query.page,
      query.pageSize,
    );
  }

  async getAdmin(id: bigint): Promise<WithdrawalView> {
    const row = await this.prisma.withdrawalApplication.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('提现申请不存在');
    }
    const settlement = await this.prisma.withdrawalSettlement.findUnique({
      where: { applicationId: row.id },
    });
    return toView(row, settlement, this.fees.withdrawalFeeBps);
  }

  async reject(id: bigint, adminId: bigint): Promise<WithdrawalView> {
    const now = await this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.requirePending(tx, id);
      await this.wallet.lockAll(tx, current.userId, now);
      await this.wallet.releaseFreeze(
        tx,
        current.userId,
        WALLET_WITHDRAWABLE,
        current.amountFen,
        now,
      );
      const updated = await tx.withdrawalApplication.update({
        where: { id: current.id },
        data: { status: WITHDRAWAL_REJECTED, updatedAt: now },
      });
      const settlement = await tx.withdrawalSettlement.create({
        data: {
          applicationId: current.id,
          userId: current.userId,
          outcome: WITHDRAWAL_REJECTED,
          amountFen: current.amountFen,
          feeFen: null,
          payoutFen: null,
          adminId,
          settledAt: now,
          createdAt: now,
        },
      });
      enqueueNotify({
        type: 'withdrawal_outcome',
        userId: current.userId,
        status: 'rejected',
        amountFen: current.amountFen,
        payoutFen: 0n,
        orderNo: current.id.toString(),
        occurredAt: now,
      });
      return { updated, settlement };
    });
    return toView(row.updated, row.settlement, this.fees.withdrawalFeeBps);
  }

  async payout(id: bigint, adminId: bigint): Promise<WithdrawalView> {
    const now = await this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.requirePending(tx, id);
      const feeFen = this.feeOf(current.amountFen);
      const payoutFen = current.amountFen - feeFen;
      await this.wallet.lockAll(tx, current.userId, now);
      await this.wallet.captureFrozen(
        tx,
        current.userId,
        WALLET_WITHDRAWABLE,
        current.amountFen,
        LEDGER_WITHDRAWAL_PAYOUT,
        current.id.toString(),
        now,
      );
      const updated = await tx.withdrawalApplication.update({
        where: { id: current.id },
        data: { status: WITHDRAWAL_PAID, updatedAt: now },
      });
      const settlement = await tx.withdrawalSettlement.create({
        data: {
          applicationId: current.id,
          userId: current.userId,
          outcome: WITHDRAWAL_PAID,
          amountFen: current.amountFen,
          feeFen,
          payoutFen,
          adminId,
          settledAt: now,
          createdAt: now,
        },
      });
      await this.cash.recordOutflow(tx, {
        amountFen: payoutFen,
        bizType: CASH_WITHDRAWAL_PAYOUT,
        bizId: current.id.toString(),
        occurredAt: now,
      });
      enqueueNotify({
        type: 'withdrawal_outcome',
        userId: current.userId,
        status: 'paid',
        amountFen: current.amountFen,
        payoutFen,
        orderNo: current.id.toString(),
        occurredAt: now,
      });
      return { updated, settlement };
    });
    return toView(row.updated, row.settlement, this.fees.withdrawalFeeBps);
  }

  /** 手续费 = 申请金额 × 万分比，向下取整到分（不足一分的零头不计）。 */
  private feeOf(amountFen: bigint): bigint {
    const bps = this.fees.withdrawalFeeBps;
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
      throw new ConflictException('提现手续费率配置无效');
    }
    return (amountFen * BigInt(bps)) / 10_000n;
  }

  private async requirePending(
    tx: Prisma.TransactionClient,
    id: bigint,
  ): Promise<WithdrawalApplication> {
    const current = await tx.withdrawalApplication.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException('提现申请不存在');
    }
    if (current.status !== WITHDRAWAL_PENDING) {
      throw new ConflictException('提现申请已处理');
    }
    return current;
  }

  private async list(
    where: { userId?: bigint; status?: string },
    page: number,
    pageSize: number,
  ): Promise<WithdrawalPage> {
    const [total, rows] = await Promise.all([
      this.prisma.withdrawalApplication.count({ where }),
      this.prisma.withdrawalApplication.findMany({
        where,
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const items: WithdrawalView[] = [];
    for (const row of rows) {
      const settlement = await this.prisma.withdrawalSettlement.findUnique({
        where: { applicationId: row.id },
      });
      items.push(toView(row, settlement, this.fees.withdrawalFeeBps));
    }
    return { items, total, page, pageSize };
  }
}

function toView(
  row: WithdrawalApplication,
  settlement: WithdrawalSettlement | null,
  feeBps: number,
): WithdrawalView {
  const feePreviewFen = (row.amountFen * BigInt(feeBps)) / 10_000n;
  return {
    id: row.id,
    userId: row.userId,
    amountFen: row.amountFen,
    feePreviewFen,
    payoutPreviewFen: row.amountFen - feePreviewFen,
    status: row.status,
    accountName: row.accountName,
    bankName: row.bankName,
    accountNo: row.accountNo,
    branchName: row.branchName,
    appliedAt: row.appliedAt.toISOString(),
    settlement: settlement
      ? {
          outcome: settlement.outcome,
          amountFen: settlement.amountFen,
          feeFen: settlement.feeFen,
          payoutFen: settlement.payoutFen,
          adminId: settlement.adminId,
          settledAt: settlement.settledAt.toISOString(),
        }
      : null,
  };
}
