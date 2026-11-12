import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AdminPrincipal } from './admin-principal';

export const CurrentAdmin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AdminPrincipal => {
    const request = ctx.switchToHttp().getRequest<{ admin?: AdminPrincipal }>();
    if (!request.admin) {
      throw new UnauthorizedException('未登录');
    }
    return request.admin;
  },
);
