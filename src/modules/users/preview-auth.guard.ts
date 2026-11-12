import { CanActivate, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

/**
 * 预览登录是否可用只看 ALLOW_PREVIEW_AUTH。
 * 不看主机名、来源 IP 或其他密钥。开关关闭时请求在参数校验之前被拒绝。
 */
@Injectable()
export class PreviewAuthEnabledGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.allowPreviewAuth) {
      throw new ForbiddenException('预览登录未启用，本次操作已忽略');
    }
    return true;
  }
}
