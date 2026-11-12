import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { WechatMiniClient } from '../src/modules/users/wechat-mini.client';
import { stage1Env } from './support/stage1-harness';

describe('wechat mini program client', () => {
  const fetchMock = jest.spyOn(global, 'fetch');

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('exchanges a login code with the configured app id and secret', async () => {
    fetchMock.mockResolvedValue(json({ openid: 'openid-1', unionid: 'union-1' }));
    const client = new WechatMiniClient(stage1Env());
    await expect(client.exchangeLoginCode('js-code')).resolves.toEqual({
      openid: 'openid-1',
      unionid: 'union-1',
    });
    const url = requestedUrl(0);
    expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/sns/jscode2session');
    expect(url.searchParams.get('appid')).toBe('wx-test-app');
    expect(url.searchParams.get('secret')).toBe('test-mini-secret');
    expect(url.searchParams.get('js_code')).toBe('js-code');
    expect(url.searchParams.get('grant_type')).toBe('authorization_code');
  });

  it('rejects an invalid code without echoing the app secret', async () => {
    fetchMock.mockResolvedValue(json({ errcode: 40029, errmsg: 'invalid code' }));
    const client = new WechatMiniClient(stage1Env());
    try {
      await client.exchangeLoginCode('bad');
      throw new Error('expected wechat login to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error instanceof Error ? error.message : String(error)).not.toContain(
        'test-mini-secret',
      );
    }
  });

  it('does not call WeChat when the mini program is not configured', async () => {
    const client = new WechatMiniClient(
      stage1Env({ wechatMiniAppId: null, wechatMiniAppSecret: null }),
    );
    await expect(client.exchangeLoginCode('js-code')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges a phone-number code and returns the pure phone number', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'token-1', expires_in: 7200 }))
      .mockResolvedValueOnce(
        json({
          errcode: 0,
          phone_info: { purePhoneNumber: '13800138000', phoneNumber: '+8613800138000' },
        }),
      );
    const client = new WechatMiniClient(stage1Env());
    await expect(client.exchangePhoneCode('phone-code')).resolves.toBe('13800138000');
    const tokenUrl = requestedUrl(0);
    expect(tokenUrl.pathname).toBe('/cgi-bin/token');
    expect(tokenUrl.searchParams.get('appid')).toBe('wx-test-app');
    const phoneUrl = requestedUrl(1);
    expect(phoneUrl.pathname).toBe('/wxa/business/getuserphonenumber');
    expect(phoneUrl.searchParams.get('access_token')).toBe('token-1');
    const init = fetchMock.mock.calls[1]?.[1];
    expect(init?.body).toBe(JSON.stringify({ code: 'phone-code' }));
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestedUrl(index: number): URL {
  const raw = fetchMockCallUrl(index);
  return new URL(raw);
}

function fetchMockCallUrl(index: number): string {
  const call = (global.fetch as unknown as jest.Mock).mock.calls[index] as unknown[] | undefined;
  const url = call?.[0];
  if (url instanceof URL) {
    return url.toString();
  }
  if (typeof url === 'string') {
    return url;
  }
  throw new Error('missing fetch url');
}
