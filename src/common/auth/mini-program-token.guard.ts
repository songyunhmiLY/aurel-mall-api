import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { MiniProgramTokenService } from './mini-program-token.service';
import { USER_STATUS_ACTIVE } from './user-status';
import type { UserPrincipal } from './user-principal';

type UserRequest = Request & { user?: UserPrincipal };

@Injectable()
export class MiniProgramTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: MiniProgramTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserRequest>();
    const token = readBearer(request.header('authorization'));
    if (!token) {
      throw new UnauthorizedException('未登录');
    }
    const payload = await this.tokens.verify(token);
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== USER_STATUS_ACTIVE) {
      throw new UnauthorizedException('登录已失效');
    }
    request.user = {
      id: user.id,
      nickname: user.nickname,
      phone: user.phone,
      status: user.status,
    };
    return true;
  }
}

function readBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}
