import { CanActivate, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class AdminJwtGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('管理端认证尚未实现');
  }
}
