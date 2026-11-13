import { Inject, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

export interface SubscribeMessage {
  openid: string;
  templateId: string;
  page: string;
  data: Record<string, string>;
}

export interface SubscribeSender {
  configured(): boolean;
  send(input: SubscribeMessage): Promise<void>;
}

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

/**
 * 小程序订阅消息。AppId / AppSecret 沿用登录用的环境变量。
 * 模板 ID 和跳转页面由管理端保存，不写在这里。
 */
@Injectable()
export class WechatSubscribeClient implements SubscribeSender {
  private cache: TokenCache | null = null;
  private http: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly clock: ClockService,
  ) {}

  /** 测试替换 HTTP，避免打到微信。 */
  bindHttp(http: (url: string, init: RequestInit) => Promise<Response>): void {
    this.http = http;
  }

  configured(): boolean {
    return Boolean(this.env.wechatMiniAppId && this.env.wechatMiniAppSecret);
  }

  async send(input: SubscribeMessage): Promise<void> {
    const now = await this.clock.now();
    const token = await this.accessToken(now, false);
    const first = await this.post(token, input);
    if (first === 0) {
      return;
    }
    if (isExpiredToken(first)) {
      const fresh = await this.accessToken(now, true);
      const again = await this.post(fresh, input);
      if (again === 0) {
        return;
      }
      throw new Error(`微信订阅消息失败 errcode=${again}`);
    }
    throw new Error(`微信订阅消息失败 errcode=${first}`);
  }

  private async accessToken(now: Date, force: boolean): Promise<string> {
    if (!force && this.cache && this.cache.expiresAtMs > now.getTime() + 60_000) {
      return this.cache.token;
    }
    const appId = this.env.wechatMiniAppId;
    const appSecret = this.env.wechatMiniAppSecret;
    if (!appId || !appSecret) {
      throw new Error('小程序未配置');
    }
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const body = await this.requestJson(url.toString(), { method: 'GET' });
    const errcode = readErrcode(body);
    if (errcode !== 0) {
      throw new Error(`微信订阅消息失败 errcode=${errcode}`);
    }
    const token = body.access_token;
    if (typeof token !== 'string' || token.length < 1) {
      throw new Error('微信订阅消息失败 errcode=token');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 7200;
    this.cache = { token, expiresAtMs: now.getTime() + expiresIn * 1000 };
    return token;
  }

  private async post(token: string, input: SubscribeMessage): Promise<number> {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
    url.searchParams.set('access_token', token);
    const data: Record<string, { value: string }> = {};
    for (const [slot, value] of Object.entries(input.data)) {
      data[slot] = { value };
    }
    const body = await this.requestJson(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: input.openid,
        template_id: input.templateId,
        page: input.page,
        miniprogram_state: 'formal',
        lang: 'zh_CN',
        data,
      }),
    });
    return readErrcode(body);
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.http(url, { ...init, signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new Error('微信订阅消息失败 errcode=network');
    }
    let parsed: unknown;
    try {
      parsed = (await response.json()) as unknown;
    } catch {
      throw new Error('微信订阅消息失败 errcode=network');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('微信订阅消息失败 errcode=network');
    }
    return parsed as Record<string, unknown>;
  }
}

function readErrcode(body: Record<string, unknown>): number {
  const errcode = body.errcode;
  if (typeof errcode === 'number') {
    return errcode;
  }
  return 0;
}

function isExpiredToken(errcode: number): boolean {
  return errcode === 40001 || errcode === 40014 || errcode === 42001;
}
