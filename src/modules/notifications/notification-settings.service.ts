import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import {
  NOTIFY_EVENTS,
  NOTIFY_EVENT_FIELDS,
  isFieldForEvent,
  isNotifyEvent,
  type NotifyEvent,
} from '../../common/notify/notify-intent';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DEFAULT_NOTIFY_PAGE,
  DEFAULT_SMS_REGION,
  NOTIFY_MODE_KEY,
  NOTIFY_PAGE_MAX,
  NOTIFY_SMS_REGION_KEY,
  NOTIFY_SMS_SDK_APP_ID_KEY,
  NOTIFY_SMS_SECRET_ID_KEY,
  NOTIFY_SMS_SECRET_KEY_KEY,
  NOTIFY_SMS_SIGN_NAME_KEY,
  eventSettingKey,
  isDeliveryMode,
  notifySettingKeys,
  type DeliveryMode,
} from './notifications.constants';

export interface SubscribeTemplate {
  event: NotifyEvent;
  templateId: string;
  page: string;
}

export interface NotifySlot {
  channel: 'wechat' | 'sms';
  slot: string;
  field: string;
}

export interface NotificationEventView {
  event: NotifyEvent;
  enabled: boolean;
  wechatTemplateId: string | null;
  smsTemplateId: string | null;
  pagePath: string | null;
  slots: NotifySlot[];
  fields: string[];
}

export interface NotificationSettingsView {
  deliveryMode: DeliveryMode | null;
  defaultPagePath: typeof DEFAULT_NOTIFY_PAGE;
  sms: {
    configured: boolean;
    secretId: string | null;
    secretKeyMasked: string | null;
    sdkAppId: string | null;
    signName: string | null;
    region: string | null;
  };
  events: NotificationEventView[];
  updatedAt: string | null;
}

export interface SmsCredentials {
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  region: string;
}

export interface NotificationEventConfig {
  enabled: boolean;
  wechatTemplateId: string | null;
  smsTemplateId: string | null;
  pagePath: string | null;
  slots: NotifySlot[];
}

export interface NotificationRuntime {
  deliveryMode: DeliveryMode | null;
  sms: SmsCredentials | null;
  events: Record<NotifyEvent, NotificationEventConfig>;
}

export interface UpdateSmsInput {
  secretId?: string;
  secretKey?: string;
  sdkAppId?: string;
  signName?: string;
  region?: string | null;
}

export interface UpdateEventInput {
  event: string;
  enabled?: boolean;
  wechatTemplateId?: string | null;
  smsTemplateId?: string | null;
  pagePath?: string | null;
  slots?: NotifySlot[];
}

export interface UpdateNotificationSettingsInput {
  deliveryMode?: string;
  sms?: UpdateSmsInput;
  events?: UpdateEventInput[];
}

@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async getView(): Promise<NotificationSettingsView> {
    const raw = await this.readRaw();
    return toView(raw);
  }

  async readForSend(): Promise<NotificationRuntime> {
    const raw = await this.readRaw();
    return toRuntime(raw);
  }

  /** 当前可向微信请求授权的订阅模板。推送方式不是微信时返回空列表。 */
  async listSubscribeTemplates(): Promise<{ templates: SubscribeTemplate[] }> {
    const runtime = await this.readForSend();
    return { templates: requestableWechatTemplates(runtime) };
  }

  async update(
    input: UpdateNotificationSettingsInput,
    adminUserId: bigint,
  ): Promise<NotificationSettingsView> {
    const writes = validateUpdate(input);
    if (writes.length === 0) {
      throw new BadRequestException('至少提供推送方式、短信配置或事件配置中的一项');
    }
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      for (const [settingKey, settingValue] of writes) {
        await tx.adminSetting.upsert({
          where: { settingKey },
          create: {
            settingKey,
            settingValue,
            updatedAt: now,
            updatedByAdminId: adminUserId,
          },
          update: {
            settingValue,
            updatedAt: now,
            updatedByAdminId: adminUserId,
          },
        });
      }
    });
    return this.getView();
  }

  private async readRaw(): Promise<Map<string, SettingRow>> {
    const rows = await this.prisma.adminSetting.findMany({
      where: { settingKey: { in: notifySettingKeys() } },
    });
    return new Map(rows.map((row) => [row.settingKey, row]));
  }
}

interface SettingRow {
  settingKey: string;
  settingValue: string;
  updatedAt: Date;
  updatedByAdminId: bigint | null;
}

function requestableWechatTemplates(runtime: NotificationRuntime): SubscribeTemplate[] {
  if (runtime.deliveryMode !== 'wechat' && runtime.deliveryMode !== 'both') {
    return [];
  }
  const templates: SubscribeTemplate[] = [];
  for (const event of NOTIFY_EVENTS) {
    const config = runtime.events[event];
    if (!config.enabled || !config.wechatTemplateId) {
      continue;
    }
    templates.push({
      event,
      templateId: config.wechatTemplateId,
      page: config.pagePath ?? DEFAULT_NOTIFY_PAGE,
    });
  }
  return templates;
}

function toView(raw: Map<string, SettingRow>): NotificationSettingsView {
  const secretKey = text(raw, NOTIFY_SMS_SECRET_KEY_KEY);
  const secretId = text(raw, NOTIFY_SMS_SECRET_ID_KEY);
  const sdkAppId = text(raw, NOTIFY_SMS_SDK_APP_ID_KEY);
  const signName = text(raw, NOTIFY_SMS_SIGN_NAME_KEY);
  return {
    deliveryMode: readMode(raw),
    defaultPagePath: DEFAULT_NOTIFY_PAGE,
    sms: {
      configured: smsReady(secretId, secretKey, sdkAppId, signName),
      secretId,
      secretKeyMasked: maskSecret(secretKey),
      sdkAppId,
      signName,
      region: text(raw, NOTIFY_SMS_REGION_KEY),
    },
    events: NOTIFY_EVENTS.map((event) => toEventView(raw, event)),
    updatedAt: latest(raw),
  };
}

function toRuntime(raw: Map<string, SettingRow>): NotificationRuntime {
  const secretId = text(raw, NOTIFY_SMS_SECRET_ID_KEY);
  const secretKey = text(raw, NOTIFY_SMS_SECRET_KEY_KEY);
  const sdkAppId = text(raw, NOTIFY_SMS_SDK_APP_ID_KEY);
  const signName = text(raw, NOTIFY_SMS_SIGN_NAME_KEY);
  const events = {} as Record<NotifyEvent, NotificationEventConfig>;
  for (const event of NOTIFY_EVENTS) {
    events[event] = {
      enabled: raw.get(eventSettingKey(event, 'enabled'))?.settingValue === '1',
      wechatTemplateId: text(raw, eventSettingKey(event, 'wx_tpl')),
      smsTemplateId: text(raw, eventSettingKey(event, 'sms_tpl')),
      pagePath: text(raw, eventSettingKey(event, 'page')),
      slots: readSlots(raw.get(eventSettingKey(event, 'slots'))?.settingValue ?? null, event),
    };
  }
  return {
    deliveryMode: readMode(raw),
    sms:
      secretId && secretKey && sdkAppId && signName
        ? {
            secretId,
            secretKey,
            sdkAppId,
            signName,
            region: text(raw, NOTIFY_SMS_REGION_KEY) ?? DEFAULT_SMS_REGION,
          }
        : null,
    events,
  };
}

function toEventView(raw: Map<string, SettingRow>, event: NotifyEvent): NotificationEventView {
  return {
    event,
    enabled: raw.get(eventSettingKey(event, 'enabled'))?.settingValue === '1',
    wechatTemplateId: text(raw, eventSettingKey(event, 'wx_tpl')),
    smsTemplateId: text(raw, eventSettingKey(event, 'sms_tpl')),
    pagePath: text(raw, eventSettingKey(event, 'page')),
    slots: readSlots(raw.get(eventSettingKey(event, 'slots'))?.settingValue ?? null, event),
    fields: [...NOTIFY_EVENT_FIELDS[event]],
  };
}

function readMode(raw: Map<string, SettingRow>): DeliveryMode | null {
  const value = text(raw, NOTIFY_MODE_KEY);
  if (!value || !isDeliveryMode(value)) {
    return null;
  }
  return value;
}

function text(raw: Map<string, SettingRow>, key: string): string | null {
  const value = raw.get(key)?.settingValue ?? '';
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function latest(raw: Map<string, SettingRow>): string | null {
  let updatedAt: Date | null = null;
  for (const row of raw.values()) {
    if (!updatedAt || row.updatedAt > updatedAt) {
      updatedAt = row.updatedAt;
    }
  }
  return updatedAt ? updatedAt.toISOString() : null;
}

function smsReady(
  secretId: string | null,
  secretKey: string | null,
  sdkAppId: string | null,
  signName: string | null,
): boolean {
  return Boolean(secretId && secretKey && sdkAppId && signName);
}

function maskSecret(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function validateUpdate(input: UpdateNotificationSettingsInput): Array<[string, string]> {
  const writes: Array<[string, string]> = [];
  if (input.deliveryMode !== undefined) {
    if (!isDeliveryMode(input.deliveryMode)) {
      throw new BadRequestException('推送方式不正确');
    }
    writes.push([NOTIFY_MODE_KEY, input.deliveryMode]);
  }
  if (input.sms !== undefined) {
    writes.push(...validateSms(input.sms));
  }
  if (input.events !== undefined) {
    if (!Array.isArray(input.events)) {
      throw new BadRequestException('事件不正确');
    }
    const seen = new Set<string>();
    for (const event of input.events) {
      if (seen.has(event.event)) {
        throw new BadRequestException('事件重复');
      }
      seen.add(event.event);
      writes.push(...validateEvent(event));
    }
  }
  return writes;
}

function validateSms(sms: UpdateSmsInput): Array<[string, string]> {
  const writes: Array<[string, string]> = [];
  if (sms.secretId !== undefined) {
    writes.push([NOTIFY_SMS_SECRET_ID_KEY, requireToken(sms.secretId, '短信 SecretId 不正确')]);
  }
  if (sms.secretKey !== undefined) {
    const secretKey = sms.secretKey.trim();
    if (!/^\S{1,128}$/.test(secretKey)) {
      throw new BadRequestException('短信密钥不正确');
    }
    writes.push([NOTIFY_SMS_SECRET_KEY_KEY, secretKey]);
  }
  if (sms.sdkAppId !== undefined) {
    if (!/^\d{1,20}$/.test(sms.sdkAppId)) {
      throw new BadRequestException('短信应用 ID 不正确');
    }
    writes.push([NOTIFY_SMS_SDK_APP_ID_KEY, sms.sdkAppId]);
  }
  if (sms.signName !== undefined) {
    const signName = sms.signName.trim();
    if (signName.length < 1 || signName.length > 64 || /[\r\n]/.test(signName)) {
      throw new BadRequestException('短信签名不正确');
    }
    writes.push([NOTIFY_SMS_SIGN_NAME_KEY, signName]);
  }
  if (sms.region !== undefined) {
    if (sms.region === null || sms.region.trim() === '') {
      writes.push([NOTIFY_SMS_REGION_KEY, '']);
    } else if (!/^[a-z0-9-]{1,32}$/.test(sms.region.trim())) {
      throw new BadRequestException('短信地域不正确');
    } else {
      writes.push([NOTIFY_SMS_REGION_KEY, sms.region.trim()]);
    }
  }
  return writes;
}

function validateEvent(input: UpdateEventInput): Array<[string, string]> {
  if (!isNotifyEvent(input.event)) {
    throw new BadRequestException('事件不正确');
  }
  const event = input.event;
  const writes: Array<[string, string]> = [];
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      throw new BadRequestException('事件开关不正确');
    }
    writes.push([eventSettingKey(event, 'enabled'), input.enabled ? '1' : '0']);
  }
  if (input.wechatTemplateId !== undefined) {
    writes.push([
      eventSettingKey(event, 'wx_tpl'),
      optionalId(input.wechatTemplateId, /^[A-Za-z0-9_-]{1,64}$/, '微信模板 ID 不正确'),
    ]);
  }
  if (input.smsTemplateId !== undefined) {
    writes.push([
      eventSettingKey(event, 'sms_tpl'),
      optionalId(input.smsTemplateId, /^\d{1,20}$/, '短信模板 ID 不正确'),
    ]);
  }
  if (input.pagePath !== undefined) {
    writes.push([eventSettingKey(event, 'page'), optionalPage(input.pagePath)]);
  }
  if (input.slots !== undefined) {
    writes.push([
      eventSettingKey(event, 'slots'),
      JSON.stringify(validateSlots(event, input.slots)),
    ]);
  }
  return writes;
}

function validateSlots(event: NotifyEvent, slots: NotifySlot[]): NotifySlot[] {
  if (!Array.isArray(slots)) {
    throw new BadRequestException('模板空位不正确');
  }
  if (slots.length > 20) {
    throw new BadRequestException('模板空位不正确');
  }
  const wechatNames = new Set<string>();
  const smsIndexes: number[] = [];
  const cleaned: NotifySlot[] = [];
  for (const slot of slots) {
    if (!slot || typeof slot.slot !== 'string' || typeof slot.field !== 'string') {
      throw new BadRequestException('模板空位不正确');
    }
    if (slot.channel !== 'wechat' && slot.channel !== 'sms') {
      throw new BadRequestException('模板空位不正确');
    }
    if (!isFieldForEvent(event, slot.field)) {
      throw new BadRequestException('模板空位对应的业务数据不正确');
    }
    if (slot.channel === 'wechat') {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(slot.slot)) {
        throw new BadRequestException('模板空位不正确');
      }
      if (wechatNames.has(slot.slot)) {
        throw new BadRequestException('模板空位重复');
      }
      wechatNames.add(slot.slot);
    } else {
      if (!/^([1-9]|1\d|20)$/.test(slot.slot)) {
        throw new BadRequestException('模板空位不正确');
      }
      smsIndexes.push(Number(slot.slot));
    }
    cleaned.push({ channel: slot.channel, slot: slot.slot, field: slot.field });
  }
  smsIndexes.sort((left, right) => left - right);
  for (let index = 0; index < smsIndexes.length; index += 1) {
    if (smsIndexes[index] !== index + 1) {
      throw new BadRequestException('短信模板空位必须从 1 连续编号');
    }
  }
  return cleaned;
}

function optionalId(value: string | null, pattern: RegExp, message: string): string {
  if (value === null || value.trim() === '') {
    return '';
  }
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    throw new BadRequestException(message);
  }
  return trimmed;
}

function optionalPage(value: string | null): string {
  if (value === null || value.trim() === '') {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length > NOTIFY_PAGE_MAX || /\s/.test(trimmed)) {
    throw new BadRequestException('跳转页面不正确');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new BadRequestException('跳转页面必须是小程序页面');
  }
  return trimmed;
}

function requireToken(value: string, message: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9]{1,128}$/.test(trimmed)) {
    throw new BadRequestException(message);
  }
  return trimmed;
}

function readSlots(raw: string | null, event: NotifyEvent): NotifySlot[] {
  if (!raw || raw.trim() === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const slots: NotifySlot[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const record = item as Record<string, unknown>;
      const channel = record.channel;
      const slot = record.slot;
      const field = record.field;
      if (
        (channel !== 'wechat' && channel !== 'sms') ||
        typeof slot !== 'string' ||
        typeof field !== 'string' ||
        !isFieldForEvent(event, field)
      ) {
        return [];
      }
      slots.push({ channel, slot, field });
    }
    return slots;
  } catch {
    return [];
  }
}
