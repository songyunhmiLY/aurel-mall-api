import { Inject, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import {
  BUSINESS_TIMEZONE,
  shanghaiBizDate,
  shanghaiBizDateBefore,
  shanghaiBizMonth,
  shanghaiDaysOverlapping,
} from '../../common/clock/shanghai-calendar';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { LockedRuntimeConfig } from '../../config/locked-runtime';
import { LOCKED_RUNTIME_CONFIG } from '../../config/tokens';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { ORDER_CLOSED, ORDER_PAID, ORDER_SHIPPED } from '../orders/order.constants';
import { PositionsService } from '../rewards/positions/positions.service';
import {
  CASH_OUTFLOW,
  CASH_WECHAT_REFUND,
  CASH_WITHDRAWAL_PAYOUT,
  WALLET_CONSUMPTION,
  WALLET_POINTS,
  WALLET_WITHDRAWABLE,
  WITHDRAWAL_PAID,
  WITHDRAWAL_PENDING,
} from '../wallet/wallet.constants';
import { nextLuckyReturn } from './ops-filing-display';
import {
  previousShanghaiDay,
  resolveOpsPeriod,
  type OpsPeriodQuery,
  type ResolvedOpsPeriod,
} from './ops-period';

const PAID_STATUSES = [ORDER_PAID, ORDER_SHIPPED];
const REFUND_PENDING = 'pending';
const FILING_COUNTER_SLOT = 1;

interface DayPayable {
  startupPayableFen: bigint;
  mallPayableFen: bigint;
}

interface ZoneTotals {
  orderCount: number;
  itemQuantity: number;
  payableFen: bigint;
}

export interface WalletTotals {
  availableFen: bigint;
  frozenFen: bigint;
}

export interface OpsCountComparison {
  count: number;
  previousDay: string;
  previousDayCount: number;
  delta: number;
}

export interface OpsZoneComposition extends ZoneTotals {
  pendingShipmentCount: number;
  shippedCount: number;
  closedCount: number;
}

export interface OpsLuckyReturn {
  id: bigint;
  triggerSequence: number;
  beneficiarySequence: number;
  beneficiaryFilingId: bigint;
  beneficiaryUserId: bigint;
  pointsFen: bigint;
  withdrawableFen: bigint;
  settledAt: Date;
}

/**
 * 管理端运营总览。只读，不改报单、结算或职位规则。
 * 微信现金、订单应付、会员钱包负债分栏返回。没有成本和利润。
 */
@Injectable()
export class OpsOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly positions: PositionsService,
    @Inject(LOCKED_RUNTIME_CONFIG) private readonly locked: LockedRuntimeConfig,
  ) {}

  async get(query: OpsPeriodQuery) {
    const now = await this.clock.now();
    const period = resolveOpsPeriod(now, query);
    const previousDay = previousShanghaiDay(period.from);
    const today = shanghaiBizDate(now);
    const [
      registeredUsers,
      seatedMembers,
      nonMembers,
      newRegistrationCount,
      newRegistrationPrevious,
      paidOrders,
      cashRows,
      pendingWithdrawals,
      paidSettlements,
      pendingRefunds,
      wallets,
      nodes,
      todayFiledCount,
      counter,
      latestSettlement,
      backlogCount,
      qualifications,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { seated: true } }),
      this.prisma.user.count({ where: { seated: false } }),
      this.prisma.user.count({
        where: { createdAt: { gte: period.from, lt: period.until } },
      }),
      this.prisma.user.count({
        where: { createdAt: { gte: previousDay.from, lt: previousDay.until } },
      }),
      this.prisma.order.findMany({
        where: {
          status: { in: PAID_STATUSES },
          paidAt: { gte: period.from, lt: period.until },
        },
      }),
      this.prisma.cashLedgerEntry.findMany({
        where: { occurredAt: { gte: period.from, lt: period.until } },
      }),
      this.prisma.withdrawalApplication.findMany({ where: { status: WITHDRAWAL_PENDING } }),
      this.prisma.withdrawalSettlement.findMany({
        where: {
          outcome: WITHDRAWAL_PAID,
          settledAt: { gte: period.from, lt: period.until },
        },
      }),
      this.prisma.orderRefund.findMany({ where: { status: REFUND_PENDING } }),
      this.prisma.walletAccount.findMany(),
      this.prisma.marketTreeNode.findMany(),
      this.prisma.filing.count({ where: { bizDate: today } }),
      this.prisma.filingCounter.findFirst({ where: { slot: FILING_COUNTER_SLOT } }),
      this.prisma.filingSettlement.findFirst({
        orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.startupSubOrder.count({ where: { filedAt: null } }),
      this.positions.qualificationCounts(shanghaiBizMonth(now)),
    ]);

    const quantities = await this.itemQuantities(paidOrders.map((order) => order.id));
    const startup = emptyZone();
    const mall = emptyZone();
    const trend = emptyTrend(period);
    let wechatCashInFen = 0n;
    for (const order of paidOrders) {
      if (!order.paidAt) {
        continue;
      }
      const zone = zoneTotals(order.zone, startup, mall);
      if (!zone) {
        continue;
      }
      zone.orderCount += 1;
      zone.payableFen += BigInt(order.payAmountFen);
      zone.itemQuantity += quantities.get(order.id.toString()) ?? 0;
      wechatCashInFen += BigInt(order.wechatFen);
      const day = trend.get(shanghaiBizDate(order.paidAt));
      if (!day) {
        continue;
      }
      if (order.zone === PRODUCT_ZONE_STARTUP) {
        day.startupPayableFen += BigInt(order.payAmountFen);
      } else if (order.zone === PRODUCT_ZONE_MALL) {
        day.mallPayableFen += BigInt(order.payAmountFen);
      }
    }

    let wechatCashRefundedFen = 0n;
    let withdrawalPayoutFen = 0n;
    for (const row of cashRows) {
      if (row.direction !== CASH_OUTFLOW) {
        continue;
      }
      if (row.bizType === CASH_WECHAT_REFUND) {
        wechatCashRefundedFen += row.amountFen;
      } else if (row.bizType === CASH_WITHDRAWAL_PAYOUT) {
        withdrawalPayoutFen += row.amountFen;
      }
    }
    const netCashFen = wechatCashInFen - wechatCashRefundedFen;
    const cofounderActivationFen = 0n;

    let pendingWithdrawalAmountFen = 0n;
    for (const row of pendingWithdrawals) {
      pendingWithdrawalAmountFen += row.amountFen;
    }
    let completedAmountFen = 0n;
    for (const row of paidSettlements) {
      completedAmountFen += row.amountFen;
    }

    const [startupStatus, mallStatus] = await Promise.all([
      this.zoneStatus(PRODUCT_ZONE_STARTUP, period),
      this.zoneStatus(PRODUCT_ZONE_MALL, period),
    ]);

    let newMemberCount = 0;
    let newMemberPrevious = 0;
    const childCount = new Map<string, number>();
    const seatedIds = new Set(nodes.map((node) => node.userId.toString()));
    for (const node of nodes) {
      const placed = node.placedAt.getTime();
      if (placed >= period.from.getTime() && placed < period.until.getTime()) {
        newMemberCount += 1;
      }
      if (placed >= previousDay.from.getTime() && placed < previousDay.until.getTime()) {
        newMemberPrevious += 1;
      }
      if (node.parentUserId !== null) {
        const parentId = node.parentUserId.toString();
        childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
      }
    }
    let membersWithThreeMarkets = 0;
    for (const [parentId, count] of childCount) {
      if (count === 3 && seatedIds.has(parentId)) {
        membersWithThreeMarkets += 1;
      }
    }

    const withdrawalUsers = userIds(pendingWithdrawals);
    const refundUsers = userIds(pendingRefunds);
    let bothPendingUserCount = 0;
    for (const userId of withdrawalUsers) {
      if (refundUsers.has(userId)) {
        bothPendingUserCount += 1;
      }
    }

    const walletTotals = sumWallets(wallets);
    const currentSequence = counter?.lastSequence ?? 0;
    const upcoming = nextLuckyReturn(currentSequence);
    const pendingWithdrawal = {
      count: pendingWithdrawals.length,
      amountFen: pendingWithdrawalAmountFen,
    };

    return {
      period: {
        key: period.key,
        timezone: BUSINESS_TIMEZONE,
        from: period.from.toISOString(),
        until: period.until.toISOString(),
        fromBizDate: shanghaiBizDate(period.from),
        untilBizDate: shanghaiBizDateBefore(period.until),
      },
      kpis: {
        registeredUsers,
        members: seatedMembers,
        newRegistrations: comparison(
          newRegistrationCount,
          previousDay.bizDate,
          newRegistrationPrevious,
        ),
        newMembers: comparison(newMemberCount, previousDay.bizDate, newMemberPrevious),
        wechatCash: {
          cashInFen: wechatCashInFen,
          cashRefundedFen: wechatCashRefundedFen,
          netFen: netCashFen,
        },
        pendingWithdrawals: pendingWithdrawal,
      },
      trend: [...trend.entries()].map(([bizDate, amounts]) => ({ bizDate, ...amounts })),
      composition: {
        startup: { ...startup, ...startupStatus },
        mall: { ...mall, ...mallStatus },
        cash: {
          wechatCashInFen,
          wechatCashRefundedFen,
          netCashFen,
          withdrawalPayoutFen,
          cofounderActivationFen,
        },
      },
      withdrawals: {
        pendingReview: pendingWithdrawal,
        completedPayouts: {
          count: paidSettlements.length,
          amountFen: completedAmountFen,
          payoutFen: withdrawalPayoutFen,
        },
        pendingRefunds: { count: pendingRefunds.length },
        mutualExclusion: {
          withdrawalBlocksRefundUserCount: withdrawalUsers.size,
          refundBlocksWithdrawalUserCount: refundUsers.size,
          bothPendingUserCount,
        },
      },
      wallets: {
        withdrawable: walletTotals.withdrawable,
        points: walletTotals.points,
        consumption: walletTotals.consumption,
        withdrawalAppliedUnpaidFen: pendingWithdrawalAmountFen,
      },
      filing: {
        todayFiledCount,
        todayBizDate: today,
        currentSequence,
        nextLuckyReturnSequence: upcoming.triggerSequence,
        nextLuckyReturnBeneficiarySequence: upcoming.beneficiarySequence,
        latestLuckyReturn: latestSettlement ? toLuckyReturn(latestSettlement) : null,
        backlogCount,
        dailyCheckTime: this.locked.filingDailyCheckTime,
      },
      organization: {
        seatedMembers,
        nonMembers,
        membersWithThreeMarkets,
        positionQualifications: {
          available: true as const,
          performanceMonth: qualifications.performanceMonth,
          thresholdFen: qualifications.thresholdFen,
          counts: qualifications.counts,
        },
      },
    };
  }

  private async itemQuantities(orderIds: bigint[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const chunkSize = 500;
    for (let offset = 0; offset < orderIds.length; offset += chunkSize) {
      const chunk = orderIds.slice(offset, offset + chunkSize);
      if (chunk.length === 0) {
        continue;
      }
      const items = await this.prisma.orderItem.findMany({ where: { orderId: { in: chunk } } });
      for (const item of items) {
        const key = item.orderId.toString();
        totals.set(key, (totals.get(key) ?? 0) + item.quantity);
      }
    }
    return totals;
  }

  private async zoneStatus(zone: string, period: ResolvedOpsPeriod) {
    const range = { gte: period.from, lt: period.until };
    const [pendingShipmentCount, shippedCount, closedCount] = await Promise.all([
      this.prisma.order.count({
        where: { zone, status: ORDER_PAID, paidAt: range },
      }),
      this.prisma.order.count({
        where: { zone, status: ORDER_SHIPPED, shippedAt: range },
      }),
      this.prisma.order.count({
        where: { zone, status: ORDER_CLOSED, closedAt: range },
      }),
    ]);
    return { pendingShipmentCount, shippedCount, closedCount };
  }
}

function emptyZone(): ZoneTotals {
  return { orderCount: 0, itemQuantity: 0, payableFen: 0n };
}

function emptyTrend(period: ResolvedOpsPeriod): Map<string, DayPayable> {
  const trend = new Map<string, DayPayable>();
  for (const bizDate of shanghaiDaysOverlapping(period.from, period.until)) {
    trend.set(bizDate, { startupPayableFen: 0n, mallPayableFen: 0n });
  }
  return trend;
}

function zoneTotals(zone: string, startup: ZoneTotals, mall: ZoneTotals): ZoneTotals | null {
  if (zone === PRODUCT_ZONE_STARTUP) {
    return startup;
  }
  if (zone === PRODUCT_ZONE_MALL) {
    return mall;
  }
  return null;
}

function comparison(
  count: number,
  previousDay: string,
  previousDayCount: number,
): OpsCountComparison {
  return { count, previousDay, previousDayCount, delta: count - previousDayCount };
}

function userIds(rows: Array<{ userId: bigint }>): Set<string> {
  return new Set(rows.map((row) => row.userId.toString()));
}

function sumWallets(
  rows: Array<{ walletType: string; balanceFen: bigint; frozenFen: bigint }>,
): Record<'withdrawable' | 'points' | 'consumption', WalletTotals> {
  const totals = {
    withdrawable: emptyWallet(),
    points: emptyWallet(),
    consumption: emptyWallet(),
  };
  for (const row of rows) {
    const bucket = walletBucket(row.walletType, totals);
    if (!bucket) {
      continue;
    }
    bucket.frozenFen += row.frozenFen;
    bucket.availableFen += row.balanceFen - row.frozenFen;
  }
  return totals;
}

function walletBucket(
  walletType: string,
  totals: Record<'withdrawable' | 'points' | 'consumption', WalletTotals>,
): WalletTotals | null {
  if (walletType === WALLET_WITHDRAWABLE) {
    return totals.withdrawable;
  }
  if (walletType === WALLET_POINTS) {
    return totals.points;
  }
  if (walletType === WALLET_CONSUMPTION) {
    return totals.consumption;
  }
  return null;
}

function emptyWallet(): WalletTotals {
  return { availableFen: 0n, frozenFen: 0n };
}

function toLuckyReturn(row: {
  id: bigint;
  triggerSequence: number;
  beneficiaryFilingId: bigint;
  beneficiaryUserId: bigint;
  pointsFen: bigint;
  withdrawableFen: bigint;
  settledAt: Date;
}): OpsLuckyReturn {
  return {
    id: row.id,
    triggerSequence: row.triggerSequence,
    beneficiarySequence: Math.floor(row.triggerSequence / 5),
    beneficiaryFilingId: row.beneficiaryFilingId,
    beneficiaryUserId: row.beneficiaryUserId,
    pointsFen: row.pointsFen,
    withdrawableFen: row.withdrawableFen,
    settledAt: row.settledAt,
  };
}
