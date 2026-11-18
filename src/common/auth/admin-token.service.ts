import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ClockService } from '../clock/clock.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

export const ADMIN_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface IssuedAdminToken {
  token: string;
  expiresAt: Date;
}

interface AdminTokenPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
}

/**
 * 管理员登录态的有效期用真实时间，不跟业务时钟。
 * staging 的仿真台会把业务时钟往后推几个月，如果这里读业务时间，
 * 推一次就把正在操作的管理员踢回登录页，仿真台根本走不完一轮。
 */
@Injectable()
export class AdminTokenService {
  constructor(
    private readonly clock: ClockService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async issue(admin: { id: bigint; username: string }): Promise<IssuedAdminToken> {
    const now = await this.clock.realNow();
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ADMIN_TOKEN_TTL_SECONDS;
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64urlJson({
      sub: admin.id.toString(),
      username: admin.username,
      iat,
      exp,
    } satisfies AdminTokenPayload);
    const data = `${header}.${payload}`;
    const signature = createHmac('sha256', this.env.adminJwtSecret)
      .update(data)
      .digest('base64url');
    return { token: `${data}.${signature}`, expiresAt: this.clock.instant(exp * 1000) };
  }

  async verify(token: string): Promise<{ sub: bigint; username: string }> {
    const parts = token.split('.');
    const headerPart = parts[0];
    const payloadPart = parts[1];
    const signature = parts[2];
    if (parts.length !== 3 || !headerPart || !payloadPart || !signature) {
      throw new UnauthorizedException('登录已失效');
    }
    let headerJson: { alg?: unknown };
    let payload: Partial<AdminTokenPayload>;
    try {
      headerJson = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
        alg?: unknown;
      };
      payload = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf8'),
      ) as Partial<AdminTokenPayload>;
    } catch {
      throw new UnauthorizedException('登录已失效');
    }
    if (headerJson.alg !== 'HS256') {
      throw new UnauthorizedException('登录已失效');
    }
    const data = `${headerPart}.${payloadPart}`;
    const expected = createHmac('sha256', this.env.adminJwtSecret).update(data).digest('base64url');
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
    return {
      sub: BigInt(payload.sub),
      username: typeof payload.username === 'string' ? payload.username : '',
    };
  }
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
