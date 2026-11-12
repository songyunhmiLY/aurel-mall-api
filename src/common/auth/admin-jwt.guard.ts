import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminPrincipal } from './admin-principal';
import { AdminTokenService } from './admin-token.service';

export const ADMIN_STATUS_ACTIVE = 'active';

type AdminRequest = Request & { admin?: AdminPrincipal };

@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly tokens: AdminTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = readBearer(request.header('authorization'));
    if (!token) {
      throw new UnauthorizedException('未登录');
    }
    const payload = await this.tokens.verify(token);
    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || admin.status !== ADMIN_STATUS_ACTIVE) {
      throw new UnauthorizedException('登录已失效');
    }
    request.admin = { id: admin.id, username: admin.username, displayName: admin.displayName };
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
