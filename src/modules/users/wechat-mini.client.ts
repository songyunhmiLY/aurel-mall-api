import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

export interface WechatMiniLoginSession {
  openid: string;
  unionid: string | null;
}

/**
 * 只调用微信小程序登录和手机号组件。
 * AppId / AppSecret 来自环境变量，不写进仓库。
 */
@Injectable()
export class WechatMiniClient {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  async exchangeLoginCode(code: string): Promise<WechatMiniLoginSession> {
    const { appId, appSecret } = this.credentials();
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const body = await this.request(url, { method: 'GET' });
    assertOk(body, new UnauthorizedException('微信登录失败'));
    const openid = body.openid;
    if (typeof openid !== 'string' || openid.length < 1 || openid.length > 128) {
      throw new UnauthorizedException('微信登录失败');
    }
    return { openid, unionid: readUnionId(body.unionid) };
  }

  async exchangePhoneCode(code: string): Promise<string> {
    const accessToken = await this.fetchAccessToken();
    const url = new URL('https://api.weixin.qq.com/wxa/business/getuserphonenumber');
    url.searchParams.set('access_token', accessToken);
    const body = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assertOk(body, new BadRequestException('微信手机号获取失败'));
    const phone = readPhone(body.phone_info);
    if (!phone) {
      throw new BadRequestException('微信手机号获取失败');
    }
    return phone;
  }

  private async fetchAccessToken(): Promise<string> {
    const { appId, appSecret } = this.credentials();
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const body = await this.request(url, { method: 'GET' });
    assertOk(body, new BadGatewayException('微信接口不可用'));
    const token = body.access_token;
    if (typeof token !== 'string' || token.length < 1) {
      throw new BadGatewayException('微信接口不可用');
    }
    return token;
  }

  private credentials(): { appId: string; appSecret: string } {
    const appId = this.env.wechatMiniAppId;
    const appSecret = this.env.wechatMiniAppSecret;
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException('小程序未配置');
    }
    return { appId, appSecret };
  }

  private async request(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new BadGatewayException('微信接口不可用');
    }
    let parsed: unknown;
    try {
      parsed = (await response.json()) as unknown;
    } catch {
      throw new BadGatewayException('微信接口不可用');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new BadGatewayException('微信接口不可用');
    }
    return parsed as Record<string, unknown>;
  }
}

function assertOk(
  body: Record<string, unknown>,
  failure: UnauthorizedException | BadRequestException | BadGatewayException,
): void {
  const errcode = body.errcode;
  if (typeof errcode === 'number' && errcode !== 0) {
    throw failure;
  }
}

function readUnionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    return null;
  }
  return trimmed;
}

function readPhone(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const pure = record.purePhoneNumber;
  const full = record.phoneNumber;
  const phone =
    typeof pure === 'string' && pure.trim() !== ''
      ? pure.trim()
      : typeof full === 'string'
        ? full.trim()
        : '';
  if (phone.length < 1 || phone.length > 32) {
    return null;
  }
  return phone;
}
