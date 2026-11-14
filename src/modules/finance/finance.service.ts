import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ORDER_PAID, ORDER_SHIPPED } from '../orders/order.constants';
import {
  CASH_INFLOW,
  CASH_ORDER_WECHAT,
  CASH_OUTFLOW,
  WITHDRAWAL_PENDING,
} from '../wallet/wallet.constants';

const PAID_STATUSES = [ORDER_PAID, ORDER_SHIPPED];

export interface FinanceRange {
  from: Date;
  to: Date;
}

export interface FinanceOverview {
  range: { from: string; to: string };
  cash: {
    inflowFen: string;
    outflowFen: string;
    netFen: string;
  };
  byBizType: Array<{ bizType: string; direction: string; amountFen: string }>;
  withdrawals: {
    pendingCount: number;
    pendingFen: string;
  };
  walletLiability: Array<{
    walletType: string;
    balanceFen: string;
    frozenFen: string;
  }>;
  walletLiabilityTotalFen: string;
}

export interface CashLedgerRow {
  id: string;
  direction: string;
  amountFen: string;
  bizType: string;
  bizId: string;
  occurredAt: string;
}

export interface CashLedgerPage {
  range: { from: string; to: string };
  rows: CashLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReconciliationView {
  range: { from: string; to: string };
  orderWechatFen: string;
  ledgerWechatFen: string;
  /** 订单侧减流水侧。非 0 说明有订单的微信实收没有记账。 */
  diffFen: string;
  matched: boolean;
  /** 差多少笔、差在哪几单。最多列 20 单。 */
  missingOrderIds: string[];
}

/**
 * 财务对账只读。不写任何流水，也不改订单。
 * 口径：
 *   - 现金流入/流出以 cash_ledger_entries 为准；
 *   - 订单侧微信实收取已支付、已发货订单的 wechat_fen；
 *   - 两边按时间段比对，差额就是漏记的收款。
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async overview(fromRaw?: string, toRaw?: string): Promise<FinanceOverview> {
    const range = await this.parseRange(fromRaw, toRaw);
    const where = { occurredAt: { gte: range.from, lt: range.to } };
    const [inflow, outflow, byType, pending, wallets] = await Promise.all([
      this.prisma.cashLedgerEntry.aggregate({
        _sum: { amountFen: true },
        where: { ...where, direction: CASH_INFLOW },
      }),
      this.prisma.cashLedgerEntry.aggregate({
        _sum: { amountFen: true },
        where: { ...where, direction: CASH_OUTFLOW },
      }),
      this.prisma.cashLedgerEntry.groupBy({
        by: ['bizType', 'direction'],
        _sum: { amountFen: true },
        where,
        orderBy: { bizType: 'asc' },
      }),
      this.prisma.withdrawalApplication.findMany({
        where: { status: WITHDRAWAL_PENDING },
        select: { amountFen: true },
      }),
      this.prisma.walletAccount.groupBy({
        by: ['walletType'],
        _sum: { balanceFen: true, frozenFen: true },
      }),
    ]);

    const inflowFen = inflow._sum.amountFen ?? 0n;
    const outflowFen = outflow._sum.amountFen ?? 0n;
    const pendingFen = pending.reduce((sum, row) => sum + BigInt(row.amountFen), 0n);
    const liabilityTotal = wallets.reduce(
      (sum, row) => sum + (row._sum.balanceFen ?? 0n) + (row._sum.frozenFen ?? 0n),
      0n,
    );

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      cash: {
        inflowFen: inflowFen.toString(),
        outflowFen: outflowFen.toString(),
        netFen: (inflowFen - outflowFen).toString(),
      },
      byBizType: byType.map((row) => ({
        bizType: row.bizType,
        direction: row.direction,
        amountFen: (row._sum.amountFen ?? 0n).toString(),
      })),
      withdrawals: {
        pendingCount: pending.length,
        pendingFen: pendingFen.toString(),
      },
      walletLiability: wallets.map((row) => ({
        walletType: row.walletType,
        balanceFen: (row._sum.balanceFen ?? 0n).toString(),
        frozenFen: (row._sum.frozenFen ?? 0n).toString(),
      })),
      walletLiabilityTotalFen: liabilityTotal.toString(),
    };
  }

  async cashLedger(input: {
    from?: string;
    to?: string;
    direction?: string;
    bizType?: string;
    page: number;
    pageSize: number;
  }): Promise<CashLedgerPage> {
    const range = await this.parseRange(input.from, input.to);
    const where = {
      occurredAt: { gte: range.from, lt: range.to },
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.bizType ? { bizType: input.bizType } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.cashLedgerEntry.count({ where }),
      this.prisma.cashLedgerEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
    ]);
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      rows: rows.map((row) => ({
        id: row.id.toString(),
        direction: row.direction,
        amountFen: row.amountFen.toString(),
        bizType: row.bizType,
        bizId: row.bizId,
        occurredAt: row.occurredAt.toISOString(),
      })),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async reconciliation(fromRaw?: string, toRaw?: string): Promise<ReconciliationView> {
    const range = await this.parseRange(fromRaw, toRaw);
    const window = { gte: range.from, lt: range.to };
    const [orders, ledger] = await Promise.all([
      this.prisma.order.aggregate({
        _sum: { wechatFen: true },
        where: { status: { in: PAID_STATUSES }, paidAt: window },
      }),
      this.prisma.cashLedgerEntry.aggregate({
        _sum: { amountFen: true },
        where: {
          direction: CASH_INFLOW,
          bizType: CASH_ORDER_WECHAT,
          occurredAt: window,
        },
      }),
    ]);
    const orderWechatFen = BigInt(orders._sum.wechatFen ?? 0);
    const ledgerWechatFen = ledger._sum.amountFen ?? 0n;
    const diffFen = orderWechatFen - ledgerWechatFen;
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      orderWechatFen: orderWechatFen.toString(),
      ledgerWechatFen: ledgerWechatFen.toString(),
      diffFen: diffFen.toString(),
      matched: diffFen === 0n,
      missingOrderIds: diffFen === 0n ? [] : await this.findMissingOrders(range),
    };
  }

  /** 抽样找漏记的订单。只取最近 200 单，避免全表扫。 */
  private async findMissingOrders(range: FinanceRange): Promise<string[]> {
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: PAID_STATUSES },
        paidAt: { gte: range.from, lt: range.to },
        wechatFen: { gt: 0 },
      },
      select: { id: true },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    if (orders.length === 0) {
      return [];
    }
    const entries = await this.prisma.cashLedgerEntry.findMany({
      where: {
        direction: CASH_INFLOW,
        bizType: CASH_ORDER_WECHAT,
        bizId: { in: orders.map((order) => order.id.toString()) },
      },
      select: { bizId: true },
    });
    const recorded = new Set(entries.map((entry) => entry.bizId));
    return orders
      .filter((order) => !recorded.has(order.id.toString()))
      .slice(0, 20)
      .map((order) => order.id.toString());
  }

  /**
   * 默认区间是本月 1 号到当前时刻，按上海自然日切。
   * 只接受 YYYY-MM-DD 或完整 ISO 时间，避免时区误读。
   */
  private async parseRange(fromRaw?: string, toRaw?: string): Promise<FinanceRange> {
    const now = await this.clock.now();
    const from = fromRaw ? await this.startOfDay(fromRaw) : await this.clock.startOfMonth(now);
    const to = toRaw ? await this.startOfNextDay(toRaw) : now;
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('开始时间必须早于结束时间');
    }
    return { from, to };
  }

  private async startOfDay(raw: string): Promise<Date> {
    return this.clock.startOfDay(this.parseDay(raw));
  }

  private async startOfNextDay(raw: string): Promise<Date> {
    const day = await this.clock.startOfDay(this.parseDay(raw));
    return new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }

  private parseDay(raw: string): Date {
    const trimmed = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      throw new BadRequestException('日期格式必须是 YYYY-MM-DD');
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('日期不正确');
    }
    return parsed;
  }
}
