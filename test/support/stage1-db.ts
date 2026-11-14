import { AsyncLocalStorage } from 'node:async_hooks';

type Row = Record<string, unknown> & { id: bigint };

interface TxScope {
  snapshot: Map<MemoryTable, { rows: Row[]; nextId: bigint }>;
  releases: Array<() => void>;
  held: Set<string>;
}

interface Filter {
  in?: unknown[];
  notIn?: unknown[];
  contains?: string;
  startsWith?: string;
  gte?: unknown;
  gt?: unknown;
  lte?: unknown;
  lt?: unknown;
}

function coded(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function same(left: unknown, right: unknown): boolean {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left === right;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function isFilter(value: unknown): value is Filter {
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  return keys.every((key) =>
    ['in', 'notIn', 'contains', 'startsWith', 'gte', 'gt', 'lte', 'lt'].includes(key),
  );
}

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) {
    return true;
  }
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'provider_identifier') {
      const compound = expected as { provider?: string; identifier?: string };
      if (row.provider !== compound.provider || row.identifier !== compound.identifier) {
        return false;
      }
      continue;
    }
    const actual = row[key];
    if (isFilter(expected)) {
      if (expected.in && !expected.in.some((item) => same(actual, item))) {
        return false;
      }
      if (expected.notIn && expected.notIn.some((item) => same(actual, item))) {
        return false;
      }
      if (
        expected.contains !== undefined &&
        (typeof actual !== 'string' || !actual.includes(expected.contains))
      ) {
        return false;
      }
      if (
        expected.startsWith !== undefined &&
        (typeof actual !== 'string' || !actual.startsWith(expected.startsWith))
      ) {
        return false;
      }
      if (expected.gte !== undefined && !compareBound(actual, expected.gte, 'gte')) {
        return false;
      }
      if (expected.gt !== undefined && !compareBound(actual, expected.gt, 'gt')) {
        return false;
      }
      if (expected.lte !== undefined && !compareBound(actual, expected.lte, 'lte')) {
        return false;
      }
      if (expected.lt !== undefined && !compareBound(actual, expected.lt, 'lt')) {
        return false;
      }
      continue;
    }
    if (!same(actual, expected)) {
      return false;
    }
  }
  return true;
}

function compareBound(actual: unknown, bound: unknown, op: 'gte' | 'gt' | 'lte' | 'lt'): boolean {
  if (actual === null || actual === undefined || bound === null || bound === undefined) {
    return false;
  }
  let delta = 0;
  if (actual instanceof Date && bound instanceof Date) {
    delta = actual.getTime() - bound.getTime();
  } else if (typeof actual === 'bigint' && typeof bound === 'bigint') {
    delta = actual < bound ? -1 : actual > bound ? 1 : 0;
  } else if (typeof actual === 'number' && typeof bound === 'number') {
    delta = actual - bound;
  } else if (typeof actual === 'string' && typeof bound === 'string') {
    delta = actual < bound ? -1 : actual > bound ? 1 : 0;
  } else {
    return false;
  }
  if (op === 'gte') {
    return delta >= 0;
  }
  if (op === 'gt') {
    return delta > 0;
  }
  if (op === 'lte') {
    return delta <= 0;
  }
  return delta < 0;
}

function cloneRow(row: Row): Row {
  const copy: Row = { id: row.id };
  for (const [key, value] of Object.entries(row)) {
    copy[key] = value instanceof Date ? new Date(value.getTime()) : value;
  }
  return copy;
}

function compareRows(left: Row, right: Row, orderBy: unknown): number {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  for (const order of orders) {
    if (!order || typeof order !== 'object') {
      continue;
    }
    for (const [key, direction] of Object.entries(order as Record<string, unknown>)) {
      const sign = direction === 'desc' ? -1 : 1;
      const av = left[key];
      const bv = right[key];
      if (same(av, bv)) {
        continue;
      }
      if (av instanceof Date && bv instanceof Date) {
        return (av.getTime() - bv.getTime()) * sign;
      }
      if (typeof av === 'bigint' && typeof bv === 'bigint') {
        return (av < bv ? -1 : 1) * sign;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * sign;
      }
      if (typeof av === 'boolean' && typeof bv === 'boolean') {
        return (Number(av) - Number(bv)) * sign;
      }
      return String(av).localeCompare(String(bv)) * sign;
    }
  }
  return 0;
}

class MemoryTable {
  rows: Row[] = [];
  private nextId = 1n;

  constructor(private readonly uniques: string[][]) {}

  findUnique(args: { where: Record<string, unknown> }): Row | null {
    return cloneRowOrNull(this.rows.find((row) => matches(row, args.where)) ?? null);
  }

  findFirst(args?: { where?: Record<string, unknown>; orderBy?: unknown }): Row | null {
    const rows = this.filtered(args?.where, args?.orderBy);
    return cloneRowOrNull(rows[0] ?? null);
  }

  findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: unknown;
    skip?: number;
    take?: number;
  }): Row[] {
    const rows = this.filtered(args?.where, args?.orderBy);
    const skip = args?.skip ?? 0;
    const take = args?.take ?? rows.length;
    return rows.slice(skip, skip + take).map((row) => cloneRow(row));
  }

  count(args?: { where?: Record<string, unknown> }): number {
    return this.rows.filter((row) => matches(row, args?.where)).length;
  }

  create(args: { data: Record<string, unknown> }): Row {
    const row = this.materialize(this.nextId++, args.data);
    this.assertUnique(row, null);
    this.rows.push(row);
    return cloneRow(row);
  }

  createMany(args: { data: Record<string, unknown>[] }): { count: number } {
    for (const data of args.data) {
      this.create({ data });
    }
    return { count: args.data.length };
  }

  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Row {
    const index = this.rows.findIndex((row) => matches(row, args.where));
    const current = this.rows[index];
    if (index < 0 || !current) {
      throw coded('P2025');
    }
    const next = this.materialize(current.id, { ...current, ...resolvedData(current, args.data) });
    this.assertUnique(next, current.id);
    this.rows[index] = next;
    return cloneRow(next);
  }

  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): {
    count: number;
  } {
    let count = 0;
    this.rows = this.rows.map((row) => {
      if (!matches(row, args.where)) {
        return row;
      }
      count += 1;
      return this.materialize(row.id, { ...row, ...resolvedData(row, args.data) });
    });
    return { count };
  }

  delete(args: { where: Record<string, unknown> }): Row {
    const index = this.rows.findIndex((row) => matches(row, args.where));
    const current = this.rows[index];
    if (index < 0 || !current) {
      throw coded('P2025');
    }
    this.rows.splice(index, 1);
    return cloneRow(current);
  }

  deleteMany(args: { where: Record<string, unknown> }): { count: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, args.where));
    return { count: before - this.rows.length };
  }

  snapshot(): { rows: Row[]; nextId: bigint } {
    return { rows: this.rows.map((row) => cloneRow(row)), nextId: this.nextId };
  }

  restore(snapshot: { rows: Row[]; nextId: bigint }): void {
    this.rows = snapshot.rows.map((row) => cloneRow(row));
    this.nextId = snapshot.nextId;
  }

  private filtered(where: Record<string, unknown> | undefined, orderBy: unknown): Row[] {
    const rows = this.rows.filter((row) => matches(row, where));
    if (!orderBy) {
      return rows;
    }
    return [...rows].sort((left, right) => compareRows(left, right, orderBy));
  }

  private materialize(id: bigint, data: Record<string, unknown>): Row {
    const row: Row = { id };
    for (const [key, value] of Object.entries(data)) {
      if (key === 'id') {
        continue;
      }
      row[key] = value instanceof Date ? new Date(value.getTime()) : value;
    }
    return row;
  }
  private assertUnique(row: Row, exceptId: bigint | null): void {
    for (const fields of this.uniques) {
      const key = uniqueKey(row, fields);
      if (key === null) {
        continue;
      }
      const clash = this.rows.find(
        (existing) => existing.id !== exceptId && uniqueKey(existing, fields) === key,
      );
      if (clash) {
        throw coded('P2002');
      }
    }
  }
}

function uniqueKey(row: Row, fields: string[]): string | null {
  const parts: string[] = [];
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) {
      return null;
    }
    parts.push(typeof value === 'bigint' ? `b:${value.toString()}` : `s:${String(value)}`);
  }
  return parts.join('|');
}

function definedData(data: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/** 支持 Prisma 的 { increment } / { decrement } 写法。 */
function resolvedData(
  current: Row,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const next = definedData(data);
  for (const [key, value] of Object.entries(next)) {
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      continue;
    }
    const op = value as { increment?: number; decrement?: number };
    if (typeof op.increment === 'number') {
      next[key] = Number(current[key] ?? 0) + op.increment;
    } else if (typeof op.decrement === 'number') {
      next[key] = Number(current[key] ?? 0) - op.decrement;
    }
  }
  return next;
}

function cloneRowOrNull(row: Row | null): Row | null {
  return row ? cloneRow(row) : null;
}

/**
 * 测试用的内存表，只覆盖本阶段服务实际调用的 Prisma 方法。
 */
export class Stage1Db {
  private readonly txScope = new AsyncLocalStorage<TxScope>();
  private readonly userLockTail = new Map<string, Promise<void>>();

  readonly user = new MemoryTable([['inviteCode']]);
  readonly adminSetting = new MemoryTable([['settingKey']]);
  readonly userIdentity = new MemoryTable([['provider', 'identifier']]);
  readonly userKyc = new MemoryTable([['userId']]);
  readonly userAddress = new MemoryTable([]);
  readonly inviteTreeNode = new MemoryTable([['userId']]);
  readonly marketTreeNode = new MemoryTable([
    ['userId'],
    ['parentUserId', 'slot'],
  ]);
  readonly marketTreeOpenSlot = new MemoryTable([['parentUserId', 'slot']]);
  readonly product = new MemoryTable([]);
  readonly productSku = new MemoryTable([['skuCode']]);
  readonly skuStock = new MemoryTable([['skuId']]);
  readonly productImage = new MemoryTable([]);
  readonly mallCategory = new MemoryTable([]);
  readonly order = new MemoryTable([['orderNo']]);
  readonly orderItem = new MemoryTable([]);
  readonly payment = new MemoryTable([['payNo'], ['channelTradeNo'], ['activeSlot']]);
  readonly walletAccount = new MemoryTable([['userId', 'walletType']]);
  readonly walletLedgerEntry = new MemoryTable([
    ['userId', 'walletType', 'direction', 'bizType', 'bizId'],
  ]);
  readonly walletHold = new MemoryTable([['orderId', 'walletType']]);
  readonly consumptionTransfer = new MemoryTable([]);
  readonly userPaymentPassword = new MemoryTable([['userId']]);
  readonly userBankAccount = new MemoryTable([['userId']]);
  readonly withdrawalApplication = new MemoryTable([]);
  readonly withdrawalSettlement = new MemoryTable([['applicationId']]);
  readonly withdrawalDisplaySource = new MemoryTable([['sourceCode']]);
  readonly cashLedgerEntry = new MemoryTable([]);
  readonly orderRefund = new MemoryTable([['wechatRefundNo']]);
  readonly rewardLedgerEntry = new MemoryTable([['userId', 'rewardType', 'bizType', 'bizId']]);
  readonly startupSubOrder = new MemoryTable([]);
  readonly filing = new MemoryTable([
    ['filingNo'],
    ['subOrderId'],
    ['sequence'],
    ['userId', 'bizDate'],
  ]);
  readonly filingCounter = new MemoryTable([['slot']]);
  readonly filingDailyCheck = new MemoryTable([['bizDate']]);
  readonly filingSettlement = new MemoryTable([['triggerSequence'], ['beneficiaryFilingId']]);
  readonly marketThresholdRevision = new MemoryTable([['effectiveMonth']]);
  readonly position = new MemoryTable([['code']]);
  readonly positionDividendPeriod = new MemoryTable([['performanceMonth']]);
  readonly positionDividendExclusion = new MemoryTable([['periodId', 'userId']]);
  readonly positionDividendRecord = new MemoryTable([['periodId', 'userId', 'positionCode']]);
  readonly redPacketDailyAccrual = new MemoryTable([['bizDate']]);
  readonly redPacketSignup = new MemoryTable([['userId', 'bizDate']]);
  readonly redPacketPayout = new MemoryTable([['userId', 'bizDate']]);
  readonly cofounderEnrollment = new MemoryTable([]);
  readonly cofounderActivation = new MemoryTable([['paymentId']]);
  readonly cofounderPool = new MemoryTable([['slot']]);
  readonly cofounderAccrual = new MemoryTable([['orderId']]);
  readonly cofounderPayoutBatch = new MemoryTable([['triggerKey']]);
  readonly cofounderPayout = new MemoryTable([['batchId', 'userId']]);
  readonly cofounderScheduleSlot = new MemoryTable([['slotKey']]);
  readonly studioEnrollment = new MemoryTable([]);
  readonly studioAccrual = new MemoryTable([['orderId', 'userId']]);
  readonly opsTeamSeat = new MemoryTable([['slot']]);
  readonly opsTeamEnrollment = new MemoryTable([['activeSlot']]);
  readonly opsTeamAccrual = new MemoryTable([['orderId']]);
  readonly banner = new MemoryTable([]);
  readonly article = new MemoryTable([]);
  readonly ticker = new MemoryTable([]);

  async $queryRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record<string, unknown>[]> {
    const sql = strings.join('?');
    if (sql.includes('FROM payments')) {
      const payNo = values[0];
      const row = this.payment.rows.find((item) => item.payNo === payNo);
      if (!row) {
        return [];
      }
      return [
        {
          id: row.id,
          orderId: row.orderId ?? null,
          payNo: row.payNo,
          channel: row.channel,
          amountFen: row.amountFen,
          status: row.status,
          succeededAt: row.succeededAt ?? null,
          purpose: row.purpose ?? 'order',
          userId: row.userId ?? null,
        },
      ];
    }
    if (sql.includes('FROM orders')) {
      const id = values[0];
      const row = this.order.rows.find((item) => item.id === id);
      if (!row) {
        return [];
      }
      return [{ id: row.id, status: row.status }];
    }
    if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
      return this.lockUserRow(values[0]);
    }
    return [];
  }

  async $transaction<T>(fn: (tx: Stage1Db) => Promise<T>): Promise<T> {
    const scope: TxScope = {
      snapshot: this.snapshot(),
      releases: [],
      held: new Set(),
    };
    try {
      return await this.txScope.run(scope, () => fn(this));
    } catch (error) {
      this.restore(scope.snapshot);
      throw error;
    } finally {
      for (const release of scope.releases) {
        release();
      }
    }
  }

  private async lockUserRow(userId: unknown): Promise<Record<string, unknown>[]> {
    const key = typeof userId === 'bigint' ? userId.toString() : String(userId);
    const scope = this.txScope.getStore();
    if (!scope?.held.has(key)) {
      const release = await this.acquireUserLock(key);
      const current = this.txScope.getStore();
      if (!current) {
        release();
      } else {
        if (current.held.size === 0) {
          current.snapshot = this.snapshot();
        }
        current.held.add(key);
        current.releases.push(release);
      }
    }
    const row = this.user.rows.find((item) => item.id === userId);
    return row ? [{ id: row.id }] : [];
  }

  private acquireUserLock(key: string): Promise<() => void> {
    const previous = this.userLockTail.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userLockTail.set(
      key,
      previous.then(
        () => gate,
        () => gate,
      ),
    );
    return previous.then(
      () => release,
      () => release,
    );
  }

  private snapshot(): Map<MemoryTable, { rows: Row[]; nextId: bigint }> {
    const tables = this.tables();
    return new Map(tables.map((table) => [table, table.snapshot()]));
  }

  private restore(snapshot: Map<MemoryTable, { rows: Row[]; nextId: bigint }>): void {
    for (const [table, state] of snapshot) {
      table.restore(state);
    }
  }

  private tables(): MemoryTable[] {
    return [
      this.user,
      this.adminSetting,
      this.userIdentity,
      this.userKyc,
      this.userAddress,
      this.inviteTreeNode,
      this.marketTreeNode,
      this.marketTreeOpenSlot,
      this.product,
      this.productSku,
      this.skuStock,
      this.productImage,
      this.mallCategory,
      this.order,
      this.orderItem,
      this.payment,
      this.walletAccount,
      this.walletLedgerEntry,
      this.walletHold,
      this.consumptionTransfer,
      this.userPaymentPassword,
      this.userBankAccount,
      this.withdrawalApplication,
      this.withdrawalSettlement,
      this.withdrawalDisplaySource,
      this.cashLedgerEntry,
      this.orderRefund,
      this.rewardLedgerEntry,
      this.startupSubOrder,
      this.filing,
      this.filingCounter,
      this.filingDailyCheck,
      this.filingSettlement,
      this.marketThresholdRevision,
      this.position,
      this.positionDividendPeriod,
      this.positionDividendExclusion,
      this.positionDividendRecord,
      this.redPacketDailyAccrual,
      this.redPacketSignup,
      this.redPacketPayout,
      this.cofounderEnrollment,
      this.cofounderActivation,
      this.cofounderPool,
      this.cofounderAccrual,
      this.cofounderPayoutBatch,
      this.cofounderPayout,
      this.cofounderScheduleSlot,
      this.studioEnrollment,
      this.studioAccrual,
      this.opsTeamSeat,
      this.opsTeamEnrollment,
      this.opsTeamAccrual,
      this.banner,
      this.article,
      this.ticker,
    ];
  }
}

/**
 * 现金流水里排除商品订单的微信实收。
 * 订单实收在 2026-11 之后由支付结算写入，断言退款、提现流水时要把它们排除。
 */
export function nonOrderCashRows(db: Stage1Db): Row[] {
  return db.cashLedgerEntry.rows.filter((row) => row.bizType !== 'order_wechat');
}
