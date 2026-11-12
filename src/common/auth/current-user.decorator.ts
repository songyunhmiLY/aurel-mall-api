import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { UserPrincipal } from './user-principal';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UserPrincipal => {
    const request = ctx.switchToHttp().getRequest<{ user?: UserPrincipal }>();
    if (!request.user) {
      throw new UnauthorizedException('未登录');
    }
    return request.user;
  },
);
