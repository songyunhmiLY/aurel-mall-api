import { Injectable, Logger } from '@nestjs/common';
import { eventOf, type NotifyIntent } from '../../common/notify/notify-intent';
import { setNotifyFlusher } from '../../common/notify/notify-buffer';
import { orderIdFromBiz, slotValues } from './format-slot';
import type { NotificationDirectory } from './notification-directory';
import { PrismaNotificationDirectory } from './notification-directory';
import {
  NotificationSettingsService,
  type NotificationRuntime,
  type NotifySlot,
} from './notification-settings.service';
import { DEFAULT_NOTIFY_PAGE, type DeliveryMode } from './notifications.constants';
import type { SmsSender } from './tencent-sms.client';
import { TencentSmsClient } from './tencent-sms.client';
import type { SubscribeSender } from './wechat-subscribe.client';
import { WechatSubscribeClient } from './wechat-subscribe.client';

const SEND_CONCURRENCY = 4;

/**
 * 事务提交之后才发送。任一渠道失败只记日志。
 * 事件关闭、推送方式未选、模板或密钥缺失、没有 openid 或手机号时，该渠道不发送。
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly settings: NotificationSettingsService,
    private readonly directory: PrismaNotificationDirectory,
    private readonly wechat: WechatSubscribeClient,
    private readonly sms: TencentSmsClient,
  ) {
    setNotifyFlusher((intents) => this.flush(intents));
  }

  async flush(intents: readonly NotifyIntent[]): Promise<void> {
    if (intents.length === 0) {
      return;
    }
    try {
      await this.deliver(intents, this.directory, this.wechat, this.sms);
    } catch (error) {
      this.logger.warn(`通知发送失败 ${errorText(error)}`);
    }
  }

  /** 测试直接调用，注入假目录和假渠道。 */
  async deliver(
    intents: readonly NotifyIntent[],
    directory: NotificationDirectory,
    wechat: SubscribeSender,
    sms: SmsSender,
  ): Promise<void> {
    const runtime = await this.settings.readForSend();
    if (!runtime.deliveryMode) {
      return;
    }
    const pending = intents.filter((intent) => runtime.events[eventOf(intent)].enabled);
    if (pending.length === 0) {
      return;
    }
    const orderIds: bigint[] = [];
    for (const intent of pending) {
      if (intent.type === 'wallet_credit') {
        const orderId = orderIdFromBiz(intent.bizId);
        if (orderId !== null) {
          orderIds.push(orderId);
        }
      }
    }
    const [recipients, orderNos] = await Promise.all([
      directory.load(pending.map((intent) => intent.userId)),
      directory.orderNos(orderIds),
    ]);
    await eachLimited(pending, SEND_CONCURRENCY, async (intent) => {
      try {
        await this.sendOne(runtime, intent, recipients, orderNos, wechat, sms);
      } catch (error) {
        this.logger.warn(
          `通知发送失败 event=${eventOf(intent)} userId=${intent.userId.toString()} ${errorText(error)}`,
        );
      }
    });
  }

  private async sendOne(
    runtime: NotificationRuntime,
    intent: NotifyIntent,
    recipients: Map<string, { openid: string | null; phoneE164: string | null }>,
    orderNos: Map<string, string>,
    wechat: SubscribeSender,
    sms: SmsSender,
  ): Promise<void> {
    const eventName = eventOf(intent);
    const event = runtime.events[eventName];
    const mode = runtime.deliveryMode;
    if (!mode || !event.enabled) {
      return;
    }
    const recipient = recipients.get(intent.userId.toString());
    const orderNo = resolveOrderNo(intent, orderNos);
    const values = slotValues(intent, orderNo);
    const page = event.pagePath ?? DEFAULT_NOTIFY_PAGE;
    if (wantsWechat(mode) && event.wechatTemplateId && recipient?.openid && wechat.configured()) {
      const data = pickSlots(event.slots, 'wechat', values);
      try {
        await wechat.send({
          openid: recipient.openid,
          templateId: event.wechatTemplateId,
          page,
          data,
        });
      } catch (error) {
        this.logger.warn(
          `通知发送失败 event=${eventName} channel=wechat userId=${intent.userId.toString()} ${errorText(error)}`,
        );
      }
    }
    if (wantsSms(mode) && event.smsTemplateId && runtime.sms && recipient?.phoneE164) {
      const params = smsParams(event.slots, values);
      try {
        await sms.send({
          secretId: runtime.sms.secretId,
          secretKey: runtime.sms.secretKey,
          sdkAppId: runtime.sms.sdkAppId,
          signName: runtime.sms.signName,
          region: runtime.sms.region,
          templateId: event.smsTemplateId,
          phoneE164: recipient.phoneE164,
          params,
        });
      } catch (error) {
        this.logger.warn(
          `通知发送失败 event=${eventName} channel=sms userId=${intent.userId.toString()} ${errorText(error)}`,
        );
      }
    }
  }
}

function wantsWechat(mode: DeliveryMode): boolean {
  return mode === 'wechat' || mode === 'both';
}

function wantsSms(mode: DeliveryMode): boolean {
  return mode === 'sms' || mode === 'both';
}

function resolveOrderNo(intent: NotifyIntent, orderNos: Map<string, string>): string {
  if (intent.type !== 'wallet_credit') {
    return intent.orderNo;
  }
  const orderId = orderIdFromBiz(intent.bizId);
  if (orderId === null) {
    return intent.bizId;
  }
  return orderNos.get(orderId.toString()) ?? intent.bizId;
}

function pickSlots(
  slots: readonly NotifySlot[],
  channel: 'wechat' | 'sms',
  values: Record<string, string>,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const slot of slots) {
    if (slot.channel !== channel) {
      continue;
    }
    data[slot.slot] = values[slot.field] ?? '';
  }
  return data;
}

function smsParams(slots: readonly NotifySlot[], values: Record<string, string>): string[] {
  const ordered = slots
    .filter((slot) => slot.channel === 'sms')
    .map((slot) => ({ index: Number(slot.slot), field: slot.field }))
    .sort((left, right) => left.index - right.index);
  const params: string[] = [];
  for (const slot of ordered) {
    params.push(values[slot.field] ?? '');
  }
  return params;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) {
        return;
      }
      const item = items[current];
      if (item === undefined) {
        return;
      }
      await fn(item);
    }
  });
  await Promise.all(workers);
}
