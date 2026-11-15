import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/app-env';
import type { WechatPayGateway } from '../src/modules/payments/wechat-pay.gateway';
import type { OrderPaymentSettler } from '../src/modules/orders/order-payment.settler';
import { WechatPayService } from '../src/modules/payments/wechat-pay.service';
import type {
  WechatPayCredentials,
  WechatPaySettingsService,
} from '../src/modules/payments/wechat-pay-settings.service';

interface OrderRow {
  id: bigint;
  orderNo: string;
  status: string;
  payAmountFen: number;
  paidAt: Date | null;
  placedAt?: Date;
  updatedAt: Date;
}

interface PaymentRow {
  id: bigint;
  orderId: bigint;
  payNo: string;
  channel: string;
  amountFen: number;
  status: string;
  channelTradeNo: string | null;
  prepayId: string | null;
  activeSlot: string | null;
  succeededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryDb {
  orders: Map<bigint, OrderRow>;
  payments: Map<bigint, PaymentRow>;
  order: {
    findUnique: (args: { where: { id: bigint } }) => Promise<OrderRow | null>;
    update: (args: { where: { id: bigint }; data: Partial<OrderRow> }) => Promise<OrderRow>;
  };
  payment: {
    findFirst: (args: {
      where: { orderId: bigint; channel: string; status: string };
    }) => Promise<PaymentRow | null>;
    create: (args: {
      data: Omit<PaymentRow, 'id' | 'channelTradeNo' | 'prepayId' | 'succeededAt'>;
    }) => Promise<PaymentRow>;
    update: (args: { where: { id: bigint }; data: Partial<PaymentRow> }) => Promise<PaymentRow>;
  };
  $transaction: <T>(fn: (tx: MemoryDb) => Promise<T>) => Promise<T>;
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  settlementCompensation: {
    findFirst: (args: unknown) => Promise<null>;
  };
}

function memoryDb(): MemoryDb {
  const orders = new Map<bigint, OrderRow>();
  const payments = new Map<bigint, PaymentRow>();
  let nextPaymentId = 1n;
  const api: MemoryDb = {
    orders,
    payments,
    order: {
      findUnique: async ({ where }: { where: { id: bigint } }) => orders.get(where.id) ?? null,
      update: jest.fn(
        async ({ where, data }: { where: { id: bigint }; data: Partial<OrderRow> }) => {
          const row = orders.get(where.id);
          if (!row) {
            throw new Error('missing order');
          }
          Object.assign(row, data);
          return row;
        },
      ),
    },
    payment: {
      findFirst: async ({
        where,
      }: {
        where: { orderId: bigint; channel: string; status: string };
      }) =>
        [...payments.values()]
          .filter(
            (row) =>
              row.orderId === where.orderId &&
              row.channel === where.channel &&
              row.status === where.status,
          )
          .sort((left, right) => (left.id < right.id ? -1 : 1))[0] ?? null,
      create: async ({
        data,
      }: {
        data: Omit<PaymentRow, 'id' | 'channelTradeNo' | 'prepayId' | 'succeededAt'>;
      }) => {
        if (
          [...payments.values()].some(
            (row) => row.activeSlot !== null && row.activeSlot === data.activeSlot,
          )
        ) {
          const error = new Error('unique') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
        const row: PaymentRow = {
          id: nextPaymentId++,
          channelTradeNo: null,
          prepayId: null,
          succeededAt: null,
          ...data,
        };
        payments.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: bigint }; data: Partial<PaymentRow> }) => {
        const row = payments.get(where.id);
        if (!row) {
          throw new Error('missing payment');
        }
        Object.assign(row, data);
        return row;
      },
    },
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>): Promise<T> {
      return fn(api);
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM payments')) {
        const payNo = values[0];
        const row = [...payments.values()].find((item) => item.payNo === payNo);
        return row ? [row] : [];
      }
      if (sql.includes('FROM orders')) {
        const id = values[0] as bigint;
        const row = orders.get(id);
        return row ? [{ id: row.id, status: row.status }] : [];
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    settlementCompensation: {
      findFirst: async () => null,
    },
  };
  return api;
}

function seedOrder(db: ReturnType<typeof memoryDb>, overrides: Partial<OrderRow> = {}): OrderRow {
  const row: OrderRow = {
    id: 7n,
    orderNo: 'M202611130001',
    status: 'pending_payment',
    payAmountFen: 12800,
    paidAt: null,
    updatedAt: new Date('2026-11-13T00:00:00.000Z'),
    ...overrides,
  };
  db.orders.set(row.id, row);
  return row;
}

function credentials(): WechatPayCredentials {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    merchantId: '1900000109',
    apiV3Key: '0123456789abcdef0123456789abcdef',
    certificatePem: 'test-certificate',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    serialNumber: 'ABC',
  };
}

describe('wechat pay orders', () => {
  const now = new Date('2026-11-13T03:04:05.000Z');
  const clock = { now: async () => now, instant: (ms: number) => new Date(ms) };

  function setup() {
    const db = memoryDb();
    const settings = {
      credentials: null as WechatPayCredentials | null,
      async readCredentials() {
        return this.credentials;
      },
      async isConfigured() {
        return this.credentials !== null;
      },
    };
    const gateway = {
      createJsapiTransaction: jest.fn(async () => ({ prepayId: 'prepay-1' })),
      verifyAndDecrypt: jest.fn(),
    };
    const env = {
      wechatPayNotifyUrl: 'https://mall.example.com/api/v1/payments/wechat/notify' as string | null,
      // 默认不启用超时对齐；需要它的用例单独打开
      orderPaymentTimeoutMinutes: 0 as number,
    };
    const service = new WechatPayService(
      db as unknown as PrismaService,
      clock as unknown as ClockService,
      settings as unknown as WechatPaySettingsService,
      gateway as unknown as WechatPayGateway,
      env as AppEnv,
      payingSettler(db),
    );
    return { db, settings, gateway, env, service };
  }

  it('simulates success only while credentials are missing, and does it once', async () => {
    const { db, service, gateway, settings } = setup();
    seedOrder(db);
    const created = await service.createPrepay({ orderId: '7' });
    expect(created.mode).toBe('sandbox');
    expect(created.paySign).toBeNull();
    expect(created.amountFen).toBe(12800);
    expect(gateway.createJsapiTransaction).not.toHaveBeenCalled();

    const again = await service.createPrepay({ orderId: '7' });
    expect(again.payNo).toBe(created.payNo);
    expect(db.payments.size).toBe(1);

    const paid = await service.simulateSuccess(created.payNo);
    expect(paid.status).toBe('success');
    expect(paid.orderStatus).toBe('paid');
    expect(paid.succeededAt).toBe(now.toISOString());
    expect(db.orders.get(7n)?.paidAt?.toISOString()).toBe(now.toISOString());

    const repeated = await service.simulateSuccess(created.payNo);
    expect(repeated.succeededAt).toBe(paid.succeededAt);
    expect(db.order.update).toHaveBeenCalledTimes(1);

    settings.credentials = credentials();
    await expect(service.simulateSuccess(created.payNo)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses sandbox after credentials are configured and leaves the payment pending', async () => {
    const { db, service, settings } = setup();
    seedOrder(db);
    const created = await service.createPrepay({ orderId: '7' });
    settings.credentials = credentials();
    await expect(service.simulateSuccess(created.payNo)).rejects.toBeInstanceOf(ForbiddenException);
    expect([...db.payments.values()][0]?.status).toBe('pending');
    expect(db.orders.get(7n)?.status).toBe('pending_payment');
  });

  it('creates a live jsapi order and reuses the prepay id', async () => {
    const { db, service, settings, gateway } = setup();
    seedOrder(db);
    settings.credentials = credentials();
    await expect(service.createPrepay({ orderId: '7' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(gateway.createJsapiTransaction).not.toHaveBeenCalled();

    const created = await service.createPrepay({
      orderId: '7',
      appId: 'wx-app',
      openid: 'openid-1',
    });
    expect(created.mode).toBe('live');
    expect(created.package).toBe('prepay_id=prepay-1');
    expect(created.paySign).toEqual(expect.any(String));
    expect(gateway.createJsapiTransaction).toHaveBeenCalledTimes(1);
    expect(gateway.createJsapiTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        outTradeNo: created.payNo,
        amountFen: 12800,
        notifyUrl: 'https://mall.example.com/api/v1/payments/wechat/notify',
        openid: 'openid-1',
      }),
    );

    const reused = await service.createPrepay({
      orderId: '7',
      appId: 'wx-app',
      openid: 'openid-1',
    });
    expect(reused.payNo).toBe(created.payNo);
    expect(gateway.createJsapiTransaction).toHaveBeenCalledTimes(1);
  });

  it('aligns the wechat prepay expiry with the unpaid timeout window', async () => {
    const { db, service, settings, gateway, env } = setup();
    env.orderPaymentTimeoutMinutes = 15;
    // 3 分钟前下单：微信侧的失效时刻应为 placedAt + 15 分钟
    seedOrder(db, { placedAt: new Date(now.getTime() - 3 * 60_000) });
    settings.credentials = credentials();
    await service.createPrepay({ orderId: '7', appId: 'wx-app', openid: 'openid-1' });
    expect(gateway.createJsapiTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ timeExpire: '2026-11-13T11:16:05+08:00' }),
    );
  });

  it('refuses to start a payment that is about to time out', async () => {
    const { db, service, settings, gateway, env } = setup();
    env.orderPaymentTimeoutMinutes = 15;
    // 只剩 30 秒：付了也会被关单，直接拦下让用户重新下单
    seedOrder(db, { placedAt: new Date(now.getTime() - 14.5 * 60_000) });
    settings.credentials = credentials();
    await expect(
      service.createPrepay({ orderId: '7', appId: 'wx-app', openid: 'openid-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gateway.createJsapiTransaction).not.toHaveBeenCalled();
  });

  it('does not call wechat when the notify url is missing, and retries a failed prepay on the same payment', async () => {
    const { db, service, settings, gateway, env } = setup();
    seedOrder(db);
    settings.credentials = credentials();
    env.wechatPayNotifyUrl = null;
    await expect(
      service.createPrepay({ orderId: '7', appId: 'wx-app', openid: 'openid-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    env.wechatPayNotifyUrl = 'https://mall.example.com/api/v1/payments/wechat/notify';
    gateway.createJsapiTransaction
      .mockRejectedValueOnce(new BadGatewayException('微信支付下单失败'))
      .mockResolvedValueOnce({ prepayId: 'prepay-2' });
    await expect(
      service.createPrepay({ orderId: '7', appId: 'wx-app', openid: 'openid-1' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    const created = await service.createPrepay({
      orderId: '7',
      appId: 'wx-app',
      openid: 'openid-1',
    });
    expect(created.package).toBe('prepay_id=prepay-2');
    expect(db.payments.size).toBe(1);
  });

  it('applies a verified callback and ignores a contradictory later state', async () => {
    const { db, service, settings, gateway } = setup();
    seedOrder(db);
    const created = await service.createPrepay({ orderId: '7' });
    settings.credentials = credentials();
    gateway.verifyAndDecrypt.mockResolvedValue({
      outTradeNo: created.payNo,
      transactionId: '4200000001',
      tradeState: 'PAYERROR',
      mchId: '1900000109',
      amountFen: 12800,
    });
    await service.handleNotify('{}', { timestamp: '1', nonce: 'n', signature: 's', serial: 'S' });
    expect([...db.payments.values()][0]?.status).toBe('failed');
    expect(db.orders.get(7n)?.status).toBe('pending_payment');

    gateway.verifyAndDecrypt.mockResolvedValue({
      outTradeNo: created.payNo,
      transactionId: '4200000001',
      tradeState: 'SUCCESS',
      mchId: '1900000109',
      amountFen: 12800,
    });
    await service.handleNotify('{}', { timestamp: '1', nonce: 'n', signature: 's', serial: 'S' });
    expect([...db.payments.values()][0]?.status).toBe('success');
    expect([...db.payments.values()][0]?.channelTradeNo).toBe('4200000001');
    expect(db.orders.get(7n)?.status).toBe('paid');
    const paidAt = db.orders.get(7n)?.paidAt?.toISOString();

    gateway.verifyAndDecrypt.mockResolvedValue({
      outTradeNo: created.payNo,
      transactionId: '4200000001',
      tradeState: 'PAYERROR',
      mchId: '1900000109',
      amountFen: 12800,
    });
    await service.handleNotify('{}', { timestamp: '1', nonce: 'n', signature: 's', serial: 'S' });
    expect([...db.payments.values()][0]?.status).toBe('success');
    expect(db.orders.get(7n)?.paidAt?.toISOString()).toBe(paidAt);
  });

  it('does not mark the order paid when the amount or merchant does not match', async () => {
    const { db, service, settings, gateway } = setup();
    seedOrder(db);
    const created = await service.createPrepay({ orderId: '7' });
    settings.credentials = credentials();
    gateway.verifyAndDecrypt.mockResolvedValue({
      outTradeNo: created.payNo,
      transactionId: '4200000002',
      tradeState: 'SUCCESS',
      mchId: '1900000109',
      amountFen: 1,
    });
    await expect(
      service.handleNotify('{}', { timestamp: '1', nonce: 'n', signature: 's', serial: 'S' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.orders.get(7n)?.status).toBe('pending_payment');

    gateway.verifyAndDecrypt.mockResolvedValue({
      outTradeNo: created.payNo,
      transactionId: '4200000002',
      tradeState: 'SUCCESS',
      mchId: '999',
      amountFen: 12800,
    });
    await expect(
      service.handleNotify('{}', { timestamp: '1', nonce: 'n', signature: 's', serial: 'S' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect([...db.payments.values()][0]?.status).toBe('pending');
  });

  it('rejects a missing order and an order that is not awaiting payment', async () => {
    const { db, service } = setup();
    await expect(service.createPrepay({ orderId: '7' })).rejects.toBeInstanceOf(NotFoundException);
    seedOrder(db, { status: 'closed' });
    await expect(service.createPrepay({ orderId: '7' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.simulateSuccess('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not mark the order paid when settlement is not wired', async () => {
    const db = memoryDb();
    seedOrder(db);
    const settings = {
      async readCredentials() {
        return null;
      },
      async isConfigured() {
        return false;
      },
    };
    const gateway = {
      createJsapiTransaction: jest.fn(),
      verifyAndDecrypt: jest.fn(),
    };
    const service = new WechatPayService(
      db as unknown as PrismaService,
      clock as unknown as ClockService,
      settings as unknown as WechatPaySettingsService,
      gateway as unknown as WechatPayGateway,
      { wechatPayNotifyUrl: null } as AppEnv,
    );
    const created = await service.createPrepay({ orderId: '7' });
    await expect(service.simulateSuccess(created.payNo)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(db.orders.get(7n)?.status).toBe('pending_payment');
    expect(db.orders.get(7n)?.paidAt).toBeNull();
    expect([...db.payments.values()][0]?.status).toBe('pending');
  });
});

function payingSettler(db: MemoryDb): OrderPaymentSettler {
  return {
    async settleWechatSuccess(_tx: unknown, orderId: bigint, paidAt: Date): Promise<string> {
      await db.order.update({
        where: { id: orderId },
        data: { status: 'paid', paidAt, updatedAt: paidAt },
      });
      return 'paid';
    },
    async releaseWechatFailure(): Promise<void> {
      return undefined;
    },
  } as unknown as OrderPaymentSettler;
}
