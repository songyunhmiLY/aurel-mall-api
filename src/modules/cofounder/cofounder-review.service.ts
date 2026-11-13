import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WALLET_WITHDRAWABLE, WITHDRAWAL_PAID } from '../wallet/wallet.constants';
import {
  COFOUNDER_AWARD_LINES,
  COFOUNDER_BIZ,
  COFOUNDER_STATUS_ACTIVE,
} from './cofounder.constants';

export interface AwardTotal {
  rewardType: string;
  label: string;
  amountFen: bigint;
}

export interface WithdrawalDetail {
  id: bigint;
  amountFen: bigint;
  status: string;
  accountName: string;
  bankName: string;
  accountNo: string;
  branchName: string;
  appliedAt: string;
  settlement: {
    outcome: string;
    amountFen: bigint;
    feeFen: bigint | null;
    payoutFen: bigint | null;
    settledAt: string;
  } | null;
}

export interface CancellationReview {
  userId: bigint;
  nickname: string;
  member: boolean;
  enrolled: boolean;
  source: string | null;
  enrolledAt: string | null;
  awards: AwardTotal[];
  cofounderDividendFen: bigint;
  withdrawable: { balanceFen: bigint; frozenFen: bigint; availableFen: bigint };
  withdrawals: {
    completedCount: number;
    completedAmountFen: bigint;
    completedPayoutFen: bigint;
    items: WithdrawalDetail[];
  };
}

/**
 * 取消前给管理员看的明细。不执行退款。
 * 联合创始人分红、当前可提现余额、已提现总额分开返回。
 * 已提现总额混有其他来源，不能当成联合创始人分红。
 */
@Injectable()
export class CofounderReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async review(userId: bigint): Promise<CancellationReview> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('会员不存在');
    }
    const enrollment = await this.prisma.cofounderEnrollment.findFirst({
      where: { userId },
      orderBy: { id: 'desc' },
    });
    if (!enrollment) {
      throw new NotFoundException('该会员不是联合创始人');
    }
    const [rewards, account, applications, settlements] = await Promise.all([
      this.prisma.rewardLedgerEntry.findMany({
        where: { userId, status: 'posted' },
      }),
      this.prisma.walletAccount.findFirst({
        where: { userId, walletType: WALLET_WITHDRAWABLE },
      }),
      this.prisma.withdrawalApplication.findMany({
        where: { userId },
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.withdrawalSettlement.findMany({ where: { userId } }),
    ]);
    const totals = new Map<string, bigint>();
    for (const row of rewards) {
      totals.set(row.rewardType, (totals.get(row.rewardType) ?? 0n) + row.amountFen);
    }
    const known = new Set<string>(COFOUNDER_AWARD_LINES.map((line) => line.rewardType));
    const awards: AwardTotal[] = COFOUNDER_AWARD_LINES.map((line) => ({
      rewardType: line.rewardType,
      label: line.label,
      amountFen: totals.get(line.rewardType) ?? 0n,
    }));
    for (const [rewardType, amountFen] of totals) {
      if (!known.has(rewardType)) {
        awards.push({ rewardType, label: rewardType, amountFen });
      }
    }
    const settlementByApplication = new Map(
      settlements.map((row) => [row.applicationId.toString(), row]),
    );
    let completedCount = 0;
    let completedAmountFen = 0n;
    let completedPayoutFen = 0n;
    const items: WithdrawalDetail[] = applications.map((row) => {
      const settlement = settlementByApplication.get(row.id.toString()) ?? null;
      if (settlement?.outcome === WITHDRAWAL_PAID) {
        completedCount += 1;
        completedAmountFen += settlement.amountFen;
        completedPayoutFen += settlement.payoutFen ?? 0n;
      }
      return {
        id: row.id,
        amountFen: row.amountFen,
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
              settledAt: settlement.settledAt.toISOString(),
            }
          : null,
      };
    });
    const balanceFen = account?.balanceFen ?? 0n;
    const frozenFen = account?.frozenFen ?? 0n;
    const active = enrollment.status === COFOUNDER_STATUS_ACTIVE;
    return {
      userId: user.id,
      nickname: user.nickname,
      member: user.member,
      enrolled: active,
      source: enrollment.source,
      enrolledAt: enrollment.enrolledAt.toISOString(),
      awards,
      cofounderDividendFen: totals.get(COFOUNDER_BIZ) ?? 0n,
      withdrawable: {
        balanceFen,
        frozenFen,
        availableFen: balanceFen - frozenFen,
      },
      withdrawals: { completedCount, completedAmountFen, completedPayoutFen, items },
    };
  }
}
