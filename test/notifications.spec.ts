import {
  BadRequestException,
  RequestMethod,
  UnauthorizedException,
  type ArgumentsHost,
  type ExecutionContext,
} from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of } from 'rxjs';
import { MiniProgramTokenGuard } from '../src/common/auth/mini-program-token.guard';
import type { MiniProgramTokenService } from '../src/common/auth/mini-program-token.service';
import type { ClockService } from '../src/common/clock/clock.service';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import {
  enqueueNotify,
  resetNotifyFlusher,
  runNotifyTransaction,
  setNotifyFlusher,
  wrapTransaction,
} from '../src/common/notify/notify-buffer';
import {
  NOTIFY_EVENTS,
  walletCreditNotifies,
  type NotifyIntent,
} from '../src/common/notify/notify-intent';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { formatYuan } from '../src/modules/notifications/format-slot';
import {
  PrismaNotificationDirectory,
  type NotifyRecipient,
} from '../src/modules/notifications/notification-directory';
import { NotificationDispatchService } from '../src/modules/notifications/notification-dispatch.service';
import { NotificationSubscribeController } from '../src/modules/notifications/notification-subscribe.controller';
import {
  NotificationSettingsService,
  type NotificationEventConfig,
  type NotificationRuntime,
  type NotifySlot,
} from '../src/modules/notifications/notification-settings.service';
import { notifySettingKeys } from '../src/modules/notifications/notifications.constants';
import { toE164 } from '../src/modules/notifications/phone-e164';
import { TencentSmsClient, type SmsMessage } from '../src/modules/notifications/tencent-sms.client';
import { signTencentCloud } from '../src/modules/notifications/tencent-sms.sign';
import {
  WechatSubscribeClient,
  type SubscribeMessage,
} from '../src/modules/notifications/wechat-subscribe.client';
import { RefundsService } from '../src/modules/orders/refunds.service';
import { WalletService } from '../src/modules/wallet/wallet.service';

const NOW = new Date('2026-11-13T02:00:00.000Z');
const SECRET = 'sms-secret-key-32';

interface SettingRow {
  settingKey: string;
  settingValue: string;
  updatedAt: Date;
  updatedByAdminId: bigint | null;
}

function memorySettings(): { rows: Map<string, SettingRow> } & PrismaService {
  const rows = new Map<string, SettingRow>();
  const api: {
    rows: Map<string, SettingRow>;
    adminSetting: {
      findMany: (args: { where: { settingKey: { in: string[] } } }) => Promise<SettingRow[]>;
      upsert: (args: {
        where: { settingKey: string };
        create: SettingRow;
        update: Partial<SettingRow>;
      }) => Promise<SettingRow>;
    };
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  } = {
    rows,
    adminSetting: {
      findMany: async ({ where }: { where: { settingKey: { in: string[] } } }) =>
        [...rows.values()].filter((row) => where.settingKey.in.includes(row.settingKey)),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { settingKey: string };
        create: SettingRow;
        update: Partial<SettingRow>;
      }) => {
        const existing = rows.get(where.settingKey);
        if (!existing) {
          rows.set(where.settingKey, create);
          return create;
        }
        const next = { ...existing, ...update, settingKey: where.settingKey };
        rows.set(where.settingKey, next);
        return next;
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(api),
  };
  return api as unknown as { rows: Map<string, SettingRow> } & PrismaService;
}

function settingsService(db: PrismaService): NotificationSettingsService {
  const clock = { now: async () => NOW } as ClockService;
  return new NotificationSettingsService(db, clock);
}

function eventConfig(patch: Partial<NotificationEventConfig> = {}): NotificationEventConfig {
  return {
    enabled: false,
    wechatTemplateId: null,
    smsTemplateId: null,
    pagePath: null,
    slots: [],
    ...patch,
  };
}

function runtime(
  patch: Partial<Omit<NotificationRuntime, 'events'>> & {
    events?: Partial<Record<(typeof NOTIFY_EVENTS)[number], Partial<NotificationEventConfig>>>;
  } = {},
): NotificationRuntime {
  const events = {} as NotificationRuntime['events'];
  for (const event of NOTIFY_EVENTS) {
    events[event] = eventConfig(patch.events?.[event]);
  }
  return {
    deliveryMode: patch.deliveryMode === undefined ? 'both' : patch.deliveryMode,
    sms: patch.sms === undefined ? null : patch.sms,
    events,
  };
}

function walletIntent(
  patch: Partial<Extract<NotifyIntent, { type: 'wallet_credit' }>> = {},
): NotifyIntent {
  return {
    type: 'wallet_credit',
    userId: 7n,
    walletType: 'withdrawable',
    amountFen: 10_000n,
    bizType: 'red_packet',
    bizId: 'order:15',
    occurredAt: NOW,
    ...patch,
  };
}

const SLOTS: NotifySlot[] = [
  { channel: 'wechat', slot: 'amount1', field: 'amount' },
  { channel: 'wechat', slot: 'time2', field: 'time' },
  { channel: 'wechat', slot: 'character_string3', field: 'orderNo' },
  { channel: 'sms', slot: '1', field: 'amount' },
  { channel: 'sms', slot: '2', field: 'orderNo' },
];

function harness(config: NotificationRuntime) {
  const settings = {
    readForSend: async () => config,
  } as NotificationSettingsService;
  const dispatch = new NotificationDispatchService(
    settings,
    {} as PrismaNotificationDirectory,
    {} as WechatSubscribeClient,
    {} as TencentSmsClient,
  );
  const wechat = {
    configured: () => true,
    sends: [] as SubscribeMessage[],
    async send(input: SubscribeMessage) {
      this.sends.push(input);
    },
  };
  const sms = {
    sends: [] as SmsMessage[],
    async send(input: SmsMessage) {
      this.sends.push(input);
    },
  };
  const directory = {
    load: jest.fn(
      async (): Promise<Map<string, NotifyRecipient>> =>
        new Map([['7', { openid: 'openid-7', phoneE164: '+8613800138000' }]]),
    ),
    orderNos: jest.fn(async () => new Map([['15', 'SO15']])),
  };
  return { dispatch, wechat, sms, directory };
}

afterEach(() => {
  resetNotifyFlusher();
});

describe('notification settings', () => {
  it('keeps setting keys inside admin_settings.setting_key', () => {
    for (const key of notifySettingKeys()) {
      expect(key.length).toBeLessThanOrEqual(64);
    }
  });

  it('rejects an empty update, a bad mode, an unknown event, a bad page, and a field the event does not have', async () => {
    const db = memorySettings();
    const service = settingsService(db);
    await expect(service.update({}, 3n)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update({ deliveryMode: 'email' }, 3n)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.update({ events: [{ event: 'order_refunded', enabled: true }] }, 3n),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(
        {
          events: [{ event: 'refund_result', pagePath: 'https://example.com/h5' }],
        },
        3n,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(
        {
          events: [
            {
              event: 'refund_result',
              slots: [{ channel: 'wechat', slot: 'thing1', field: 'bizType' }],
            },
          ],
        },
        3n,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(
        {
          events: [
            {
              event: 'refund_result',
              slots: [
                { channel: 'sms', slot: '1', field: 'amount' },
                { channel: 'sms', slot: '3', field: 'time' },
              ],
            },
          ],
        },
        3n,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.rows.size).toBe(0);
  });

  it('stores switches independently, masks the sms secret, and clears a page back to the default', async () => {
    const db = memorySettings();
    const service = settingsService(db);
    const saved = await service.update(
      {
        deliveryMode: 'both',
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
        },
        events: [
          {
            event: 'refund_result',
            enabled: true,
            wechatTemplateId: 'wx-tpl-refund',
            smsTemplateId: '1001',
            pagePath: 'pages/order/refunds',
            slots: [{ channel: 'wechat', slot: 'amount1', field: 'amount' }],
          },
          { event: 'wallet_credit_points', enabled: false },
        ],
      },
      9n,
    );
    expect(saved.deliveryMode).toBe('both');
    expect(saved.defaultPagePath).toBe('pages/mine/index');
    expect(saved.sms.configured).toBe(true);
    expect(saved.sms.secretId).toBe('AKIDtest');
    expect(saved.sms.secretKeyMasked?.endsWith(SECRET.slice(-4))).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    const refund = saved.events.find((event) => event.event === 'refund_result');
    const points = saved.events.find((event) => event.event === 'wallet_credit_points');
    const withdrawable = saved.events.find((event) => event.event === 'wallet_credit_withdrawable');
    expect(refund?.enabled).toBe(true);
    expect(refund?.pagePath).toBe('pages/order/refunds');
    expect(refund?.slots).toEqual([{ channel: 'wechat', slot: 'amount1', field: 'amount' }]);
    expect(points?.enabled).toBe(false);
    expect(withdrawable?.enabled).toBe(false);
    expect(db.rows.get('notify_sms_secret_key')?.settingValue).toBe(SECRET);
    expect(db.rows.get('notify_sms_secret_key')?.updatedByAdminId).toBe(9n);

    const cleared = await service.update(
      { events: [{ event: 'refund_result', pagePath: '' }] },
      9n,
    );
    expect(cleared.events.find((event) => event.event === 'refund_result')?.pagePath).toBeNull();
    expect(cleared.events.find((event) => event.event === 'refund_result')?.enabled).toBe(true);
    expect(cleared.deliveryMode).toBe('both');

    const runtime = await service.readForSend();
    expect(runtime.sms?.secretKey).toBe(SECRET);
    expect(runtime.sms?.region).toBe('ap-guangzhou');
    expect(runtime.events.refund_result.pagePath).toBeNull();
    expect(runtime.events.wallet_credit_points.enabled).toBe(false);
  });

  it('returns 401 when the subscribe-template route is called without a login', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, NotificationSubscribeController)).toEqual([
      MiniProgramTokenGuard,
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, NotificationSubscribeController)).toBe(
      'notifications',
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        NotificationSubscribeController.prototype.subscribeTemplates,
      ),
    ).toBe('subscribe-templates');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        NotificationSubscribeController.prototype.subscribeTemplates,
      ),
    ).toBe(RequestMethod.GET);

    const guard = new MiniProgramTokenGuard(
      {} as unknown as MiniProgramTokenService,
      {} as PrismaService,
    );
    const anonymous = {
      header: () => undefined,
    };
    let error: unknown;
    try {
      await guard.canActivate({
        switchToHttp: () => ({ getRequest: () => anonymous }),
      } as ExecutionContext);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnauthorizedException);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    new AllExceptionsFilter().catch(error, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as ArgumentsHost);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      code: 401,
      message: '未登录',
      data: null,
    });

    const loggedIn: {
      header: (name: string) => string | undefined;
      user?: { id: bigint };
    } = {
      header: (name: string) => (name === 'authorization' ? 'Bearer session' : undefined),
    };
    const memberGuard = new MiniProgramTokenGuard(
      { verify: async () => ({ sub: 4n }) } as unknown as MiniProgramTokenService,
      {
        user: {
          findUnique: async () => ({
            id: 4n,
            nickname: '访客',
            phone: null,
            status: 'active',
            member: false,
          }),
        },
      } as unknown as PrismaService,
    );
    await expect(
      memberGuard.canActivate({
        switchToHttp: () => ({ getRequest: () => loggedIn }),
      } as ExecutionContext),
    ).resolves.toBe(true);
    expect(loggedIn.user?.id).toBe(4n);
  });

  it('lists requestable wechat templates and omits the sms secret', async () => {
    const db = memorySettings();
    const service = settingsService(db);
    const controller = new NotificationSubscribeController(service);

    expect(await controller.subscribeTemplates()).toEqual({ templates: [] });

    await service.update(
      {
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
        },
        events: [
          {
            event: 'refund_result',
            enabled: true,
            wechatTemplateId: 'wx-tpl-refund',
            smsTemplateId: '1001',
            pagePath: 'pages/order/refunds',
          },
          {
            event: 'lucky_return_credited',
            enabled: true,
            wechatTemplateId: 'wx-tpl-lucky',
          },
          {
            event: 'withdrawal_outcome',
            enabled: false,
            wechatTemplateId: 'wx-tpl-withdraw',
          },
          {
            event: 'wallet_credit_points',
            enabled: true,
            smsTemplateId: '1002',
          },
          {
            event: 'wallet_credit_withdrawable',
            enabled: true,
            wechatTemplateId: '',
          },
        ],
      },
      9n,
    );

    const unset = await controller.subscribeTemplates();
    expect(unset).toEqual({ templates: [] });

    await service.update({ deliveryMode: 'sms' }, 9n);
    const smsOnly = await controller.subscribeTemplates();
    expect(smsOnly).toEqual({ templates: [] });
    expect(JSON.stringify(smsOnly)).not.toContain(SECRET);

    await service.update({ deliveryMode: 'wechat' }, 9n);
    const wechat = await controller.subscribeTemplates();
    expect(wechat).toEqual({
      templates: [
        { event: 'refund_result', templateId: 'wx-tpl-refund', page: 'pages/order/refunds' },
        { event: 'lucky_return_credited', templateId: 'wx-tpl-lucky', page: 'pages/mine/index' },
      ],
    });

    await service.update({ deliveryMode: 'both' }, 9n);
    const both = await controller.subscribeTemplates();
    const wire = await lastValueFrom(
      new ResponseInterceptor().intercept({} as never, { handle: () => of(both) }),
    );
    expect(wire).toEqual({
      code: 0,
      message: 'ok',
      data: {
        templates: [
          { event: 'refund_result', templateId: 'wx-tpl-refund', page: 'pages/order/refunds' },
          { event: 'lucky_return_credited', templateId: 'wx-tpl-lucky', page: 'pages/mine/index' },
        ],
      },
    });
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('AKIDtest');
    expect(serialized).not.toContain('1001');
    expect(serialized).not.toContain('1002');
    expect(serialized).not.toContain('wx-tpl-withdraw');
    expect(Object.keys(both)).toEqual(['templates']);
    for (const template of both.templates) {
      expect(Object.keys(template).sort()).toEqual(['event', 'page', 'templateId']);
    }
  });
});

describe('notification delivery', () => {
  it('uses the global mode for every enabled event and skips a disabled event', async () => {
    const config = runtime({
      deliveryMode: 'wechat',
      sms: {
        secretId: 'AKIDtest',
        secretKey: SECRET,
        sdkAppId: '1400',
        signName: '奥瑞尔',
        region: 'ap-guangzhou',
      },
      events: {
        wallet_credit_withdrawable: {
          enabled: true,
          wechatTemplateId: 'wx-wd',
          smsTemplateId: '2001',
          slots: SLOTS,
        },
        wallet_credit_points: {
          enabled: false,
          wechatTemplateId: 'wx-pt',
          smsTemplateId: '2002',
          slots: SLOTS,
        },
      },
    });
    const { dispatch, wechat, sms, directory } = harness(config);
    await dispatch.deliver(
      [
        walletIntent(),
        walletIntent({ walletType: 'points', amountFen: 500n, bizId: 'order:15:layer:2' }),
      ],
      directory,
      wechat,
      sms,
    );
    expect(sms.sends).toEqual([]);
    expect(wechat.sends).toHaveLength(1);
    expect(wechat.sends[0]).toEqual({
      openid: 'openid-7',
      templateId: 'wx-wd',
      page: 'pages/mine/index',
      data: {
        amount1: '100.00',
        time2: '2026-11-13 10:00',
        character_string3: 'SO15',
      },
    });
  });

  it('fills the order paid and shipped slots from the order itself', async () => {
    const config = runtime({
      deliveryMode: 'wechat',
      events: {
        order_paid: {
          enabled: true,
          wechatTemplateId: 'wx-paid',
          pagePath: 'pages/order/detail?id=15',
          slots: [
            { channel: 'wechat', slot: 'character_string1', field: 'orderNo' },
            { channel: 'wechat', slot: 'amount2', field: 'amount' },
            { channel: 'wechat', slot: 'thing3', field: 'goodsName' },
            { channel: 'wechat', slot: 'time4', field: 'time' },
          ],
        },
        order_shipped: {
          enabled: true,
          wechatTemplateId: 'wx-ship',
          slots: [
            { channel: 'wechat', slot: 'character_string1', field: 'orderNo' },
            { channel: 'wechat', slot: 'thing2', field: 'courierName' },
            { channel: 'wechat', slot: 'character_string3', field: 'trackingNo' },
            { channel: 'wechat', slot: 'time4', field: 'time' },
          ],
        },
      },
    });
    const { dispatch, wechat, sms, directory } = harness(config);
    await dispatch.deliver(
      [
        {
          type: 'order_paid',
          userId: 7n,
          orderNo: 'SO15',
          amountFen: 123_450n,
          goodsName: '创业专区礼包 等 2 件',
          occurredAt: NOW,
        },
        {
          type: 'order_shipped',
          userId: 7n,
          orderNo: 'SO15',
          courierName: '顺丰',
          trackingNo: 'SF123',
          occurredAt: NOW,
        },
      ],
      directory,
      wechat,
      sms,
    );
    expect(sms.sends).toEqual([]);
    const paid = wechat.sends.find((send) => send.templateId === 'wx-paid');
    const shipped = wechat.sends.find((send) => send.templateId === 'wx-ship');
    expect(paid?.page).toBe('pages/order/detail?id=15');
    expect(paid?.data).toEqual({
      character_string1: 'SO15',
      amount2: '1234.50',
      thing3: '创业专区礼包 等 2 件',
      time4: '2026-11-13 10:00',
    });
    expect(shipped?.page).toBe('pages/mine/index');
    expect(shipped?.data).toEqual({
      character_string1: 'SO15',
      thing2: '顺丰',
      character_string3: 'SF123',
      time4: '2026-11-13 10:00',
    });
  });

  it('sends sms only when that channel is selected, and both when the mode is both', async () => {
    const base = {
      events: {
        refund_result: {
          enabled: true,
          wechatTemplateId: 'wx-rf',
          smsTemplateId: '3001',
          pagePath: 'pages/order/refund',
          slots: [
            { channel: 'wechat' as const, slot: 'phrase1', field: 'status' },
            { channel: 'sms' as const, slot: '1', field: 'amount' },
            { channel: 'sms' as const, slot: '2', field: 'status' },
          ],
        },
      },
    };
    const intent: NotifyIntent = {
      type: 'refund_result',
      userId: 7n,
      status: 'rejected',
      amountFen: 0n,
      orderNo: 'MO7',
      occurredAt: NOW,
    };
    const smsOnly = harness(
      runtime({
        ...base,
        deliveryMode: 'sms',
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
          region: 'ap-guangzhou',
        },
      }),
    );
    await smsOnly.dispatch.deliver([intent], smsOnly.directory, smsOnly.wechat, smsOnly.sms);
    expect(smsOnly.wechat.sends).toEqual([]);
    expect(smsOnly.sms.sends[0]?.params).toEqual(['0.00', 'rejected']);
    expect(smsOnly.sms.sends[0]?.templateId).toBe('3001');

    const both = harness(
      runtime({
        ...base,
        deliveryMode: 'both',
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
          region: 'ap-guangzhou',
        },
      }),
    );
    await both.dispatch.deliver([intent], both.directory, both.wechat, both.sms);
    expect(both.wechat.sends[0]?.page).toBe('pages/order/refund');
    expect(both.wechat.sends[0]?.data).toEqual({ phrase1: 'rejected' });
    expect(both.sms.sends).toHaveLength(1);
  });

  it('does not send when the template, credentials, openid, or phone is missing', async () => {
    const intent = walletIntent();
    const missingTemplate = harness(
      runtime({
        deliveryMode: 'both',
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
          region: 'ap-guangzhou',
        },
        events: {
          wallet_credit_withdrawable: { enabled: true, smsTemplateId: '9', slots: SLOTS },
        },
      }),
    );
    await missingTemplate.dispatch.deliver(
      [intent],
      missingTemplate.directory,
      missingTemplate.wechat,
      missingTemplate.sms,
    );
    expect(missingTemplate.wechat.sends).toEqual([]);
    expect(missingTemplate.sms.sends).toHaveLength(1);

    const missingSms = harness(
      runtime({
        deliveryMode: 'both',
        sms: null,
        events: {
          wallet_credit_withdrawable: {
            enabled: true,
            wechatTemplateId: 'wx-wd',
            smsTemplateId: '9',
            slots: SLOTS,
          },
        },
      }),
    );
    await missingSms.dispatch.deliver(
      [intent],
      missingSms.directory,
      missingSms.wechat,
      missingSms.sms,
    );
    expect(missingSms.wechat.sends).toHaveLength(1);
    expect(missingSms.sms.sends).toEqual([]);

    const noIdentity = harness(
      runtime({
        deliveryMode: 'both',
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
          region: 'ap-guangzhou',
        },
        events: {
          wallet_credit_withdrawable: {
            enabled: true,
            wechatTemplateId: 'wx-wd',
            smsTemplateId: '9',
            slots: SLOTS,
          },
        },
      }),
    );
    noIdentity.directory.load.mockResolvedValue(
      new Map([['7', { openid: null, phoneE164: null }]]),
    );
    noIdentity.wechat.configured = () => false;
    await noIdentity.dispatch.deliver(
      [intent],
      noIdentity.directory,
      noIdentity.wechat,
      noIdentity.sms,
    );
    expect(noIdentity.wechat.sends).toEqual([]);
    expect(noIdentity.sms.sends).toEqual([]);
  });

  it('does not send before the mode is chosen, and a channel error does not reject the flush', async () => {
    const unconfigured = harness(runtime({ deliveryMode: null }));
    await unconfigured.dispatch.deliver(
      [walletIntent()],
      unconfigured.directory,
      unconfigured.wechat,
      unconfigured.sms,
    );
    expect(unconfigured.directory.load).not.toHaveBeenCalled();

    const failing = harness(
      runtime({
        deliveryMode: 'both',
        sms: {
          secretId: 'AKIDtest',
          secretKey: SECRET,
          sdkAppId: '1400',
          signName: '奥瑞尔',
          region: 'ap-guangzhou',
        },
        events: {
          lucky_return_credited: {
            enabled: true,
            wechatTemplateId: 'wx-lr',
            smsTemplateId: '8',
            slots: [
              { channel: 'wechat', slot: 'amount1', field: 'amount' },
              { channel: 'sms', slot: '1', field: 'pointsAmount' },
              { channel: 'sms', slot: '2', field: 'withdrawableAmount' },
            ],
          },
        },
      }),
    );
    failing.wechat.send = async () => {
      throw new Error('微信订阅消息失败 errcode=43101');
    };
    const intent: NotifyIntent = {
      type: 'lucky_return_credited',
      userId: 7n,
      pointsFen: 100_000n,
      withdrawableFen: 20_000n,
      orderNo: 'SO9',
      occurredAt: NOW,
    };
    await expect(
      failing.dispatch.deliver([intent], failing.directory, failing.wechat, failing.sms),
    ).resolves.toBeUndefined();
    expect(failing.sms.sends[0]?.params).toEqual(['1000.00', '200.00']);
    expect(formatYuan(100_000n + 20_000n)).toBe('1200.00');
  });
});

describe('notification buffer', () => {
  it('drops an enqueue outside a transaction and does not flush a failed callback', async () => {
    const flushed: NotifyIntent[] = [];
    setNotifyFlusher(async (items) => {
      flushed.push(...items);
    });
    enqueueNotify(walletIntent());
    expect(flushed).toEqual([]);

    const wrapped = wrapTransaction(async (fn) => {
      if (typeof fn === 'function') {
        return fn('tx');
      }
      return 'batch';
    });
    await expect(
      wrapped(async () => {
        enqueueNotify(walletIntent());
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(flushed).toEqual([]);

    await wrapped(async () => {
      enqueueNotify(walletIntent({ bizType: 'studio' }));
      return 1;
    });
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.type).toBe('wallet_credit');

    await expect(
      runNotifyTransaction(
        async () => {
          enqueueNotify(walletIntent());
          return 'ok';
        },
        async () => {
          throw new Error('sms down');
        },
      ),
    ).resolves.toBe('ok');
  });

  it('queues a wallet credit inside the transaction and skips lucky return and refund credits', async () => {
    const wallet = new WalletService({} as PrismaService, { now: async () => NOW } as ClockService);
    const tx = {
      walletAccount: {
        findFirst: async () => ({
          id: 1n,
          balanceFen: 0n,
          frozenFen: 0n,
        }),
        update: async () => ({}),
      },
      walletLedgerEntry: { create: async () => ({}) },
    };
    const flushed: NotifyIntent[] = [];
    await runNotifyTransaction(
      async () => {
        await wallet.creditInTx(
          tx as never,
          {
            userId: 7n,
            walletType: 'withdrawable',
            amountFen: 250n,
            bizType: 'red_packet',
            bizId: '2026-11-13',
            sourceCode: 'red_packet',
          },
          NOW,
        );
        await wallet.creditInTx(
          tx as never,
          {
            userId: 7n,
            walletType: 'points',
            amountFen: 100n,
            bizType: 'filing_settlement',
            bizId: 'filing:1',
            sourceCode: null,
          },
          NOW,
        );
        await wallet.creditInTx(
          tx as never,
          {
            userId: 7n,
            walletType: 'consumption',
            amountFen: 80n,
            bizType: 'mall_refund',
            bizId: '4',
            sourceCode: null,
          },
          NOW,
        );
      },
      async (items) => {
        flushed.push(...items);
      },
    );
    expect(
      flushed.map((item) => (item.type === 'wallet_credit' ? item.bizType : item.type)),
    ).toEqual(['red_packet']);
    expect(walletCreditNotifies('studio')).toBe(true);
    expect(walletCreditNotifies('filing_settlement')).toBe(false);
    expect(walletCreditNotifies('mall_refund')).toBe(false);
  });

  it('queues a refund result from the reject path', async () => {
    const now = NOW;
    const row = {
      id: 4n,
      orderId: 8n,
      userId: 7n,
      status: 'pending',
      payAmountFen: 1000,
      freightFen: 0,
      refundFen: null,
      deductionFen: null,
      wechatRefundFen: null,
      withdrawableDeductionFen: null,
      consumptionCreditFen: null,
      wechatRefundStatus: null,
      wechatRefundNo: null,
      appliedAt: now,
      decidedAt: null,
      decidedByAdminId: null,
      createdAt: now,
      updatedAt: now,
    };
    const flushed: NotifyIntent[] = [];
    const tx = {
      orderRefund: {
        findUnique: async () => row,
        update: async () => ({ ...row, status: 'rejected', decidedAt: now }),
      },
      order: { findUnique: async () => ({ orderNo: 'MO8' }) },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) =>
        runNotifyTransaction(
          () => fn(tx),
          async (items) => {
            flushed.push(...items);
          },
        ),
    };
    const refunds = new RefundsService(
      prisma as unknown as PrismaService,
      { now: async () => now } as ClockService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const view = await refunds.reject(4n, 3n);
    expect(view.status).toBe('rejected');
    expect(flushed).toEqual([
      {
        type: 'refund_result',
        userId: 7n,
        status: 'rejected',
        amountFen: 0n,
        orderNo: 'MO8',
        occurredAt: now,
      },
    ]);
  });
});

describe('phone and tencent signature', () => {
  it('turns a mainland mobile into E.164 and leaves other shapes alone', () => {
    expect(toE164('13800138000')).toBe('+8613800138000');
    expect(toE164('138 0013-8000')).toBe('+8613800138000');
    expect(toE164('+33612345678')).toBe('+33612345678');
    expect(toE164('12345')).toBeNull();
    expect(toE164(null)).toBeNull();
  });

  it('matches the published TC3-HMAC-SHA256 example', () => {
    const secretId = `AKID${'*'.repeat(32)}`;
    const payload =
      '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
    const signed = signTencentCloud({
      secretId,
      secretKey: '*'.repeat(32),
      service: 'cvm',
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      version: '2017-03-12',
      region: 'ap-guangzhou',
      timestamp: 1551113065,
      payload,
    });
    expect(signed.headers.Authorization).toBe(
      'TC3-HMAC-SHA256 Credential=AKID********************************/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f',
    );
    expect(signed.headers['X-TC-Action']).toBe('DescribeInstances');
    expect(signed.body).toBe(payload);
  });
});
