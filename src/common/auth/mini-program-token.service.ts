import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import { ClockService } from '../clock/clock.service';

/** 小程序会话时长。这是令牌有效期，不是业务规则里的期限。 */
export const MINI_PROGRAM_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_TYPE = 'mini';

export interface IssuedMiniProgramToken {
  token: string;
  expiresAt: Date;
}

interface MiniProgramTokenPayload {
  sub: string;
  typ: typeof TOKEN_TYPE;
  iat: number;
  exp: number;
}

@Injectable()
export class MiniProgramTokenService {
  constructor(
    private readonly clock: ClockService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async issue(userId: bigint): Promise<IssuedMiniProgramToken> {
    // 登录态有效期是真实世界的七天，不跟业务时钟。否则 staging 里推进一天仿真，
    // 全部会员的 token 会立刻过期，小程序端得反复重新登录。
    const now = await this.clock.realNow();
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + MINI_PROGRAM_TOKEN_TTL_SECONDS;
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64urlJson({
      sub: userId.toString(),
      typ: TOKEN_TYPE,
      iat,
      exp,
    } satisfies MiniProgramTokenPayload);
    const data = `${header}.${payload}`;
    const signature = createHmac('sha256', this.env.miniProgramTokenSecret)
      .update(data)
      .digest('base64url');
    return { token: `${data}.${signature}`, expiresAt: this.clock.instant(exp * 1000) };
  }

  async verify(token: string): Promise<{ sub: bigint }> {
    const parts = token.split('.');
    const headerPart = parts[0];
    const payloadPart = parts[1];
    const signature = parts[2];
    if (parts.length !== 3 || !headerPart || !payloadPart || !signature) {
      throw new UnauthorizedException('登录已失效');
    }
    let headerJson: { alg?: unknown };
    let payload: Partial<MiniProgramTokenPayload>;
    try {
      headerJson = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
        alg?: unknown;
      };
      payload = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf8'),
      ) as Partial<MiniProgramTokenPayload>;
    } catch {
      throw new UnauthorizedException('登录已失效');
    }
    if (headerJson.alg !== 'HS256' || payload.typ !== TOKEN_TYPE) {
      throw new UnauthorizedException('登录已失效');
    }
    const data = `${headerPart}.${payloadPart}`;
    const expected = createHmac('sha256', this.env.miniProgramTokenSecret)
      .update(data)
      .digest('base64url');
    const actualBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      throw new UnauthorizedException('登录已失效');
    }
    if (
      typeof payload.sub !== 'string' ||
      !/^\d+$/.test(payload.sub) ||
      typeof payload.exp !== 'number'
    ) {
      throw new UnauthorizedException('登录已失效');
    }
    const now = await this.clock.realNow();
    if (Math.floor(now.getTime() / 1000) >= payload.exp) {
      throw new UnauthorizedException('登录已失效');
    }
    return { sub: BigInt(payload.sub) };
  }
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
