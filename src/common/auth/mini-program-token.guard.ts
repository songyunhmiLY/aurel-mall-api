import { CanActivate, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class MiniProgramTokenGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('小程序认证尚未实现');
  }
}
