import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ADMIN_STATUS_ACTIVE } from '../../common/auth/admin-jwt.guard';
import { AdminTokenService } from '../../common/auth/admin-token.service';
import { hashPassword, verifyPassword } from '../../common/auth/password-hasher';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';

export interface AdminLoginResult {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
  admin: {
    id: bigint;
    username: string;
    displayName: string;
  };
}

/**
 * 管理员只有一种角色，权限相同，可以有多个账户。
 * 初始账户来自环境变量，且只在该用户名尚不存在时创建一次，不会覆盖已有密码。
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly tokens: AdminTokenService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    const username = this.env.adminBootstrapUsername;
    const password = this.env.adminBootstrapPassword;
    if (!username || !password) {
      return;
    }
    const existing = await this.prisma.adminUser.findUnique({ where: { username } });
    if (existing) {
      this.logger.log(`admin bootstrap skipped, username already exists: ${username}`);
      return;
    }
    const now = await this.clock.now();
    const passwordHash = await hashPassword(password);
    if (passwordHash.length > 255) {
      throw new Error('密码哈希超出 admin_users.password_hash 长度');
    }
    try {
      await this.prisma.adminUser.create({
        data: {
          username,
          passwordHash,
          displayName: this.env.adminBootstrapDisplayName ?? username,
          status: ADMIN_STATUS_ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return;
      }
      throw error;
    }
    this.logger.log(`bootstrapped admin user: ${username}`);
  }

  async login(username: string, password: string): Promise<AdminLoginResult> {
    const admin = await this.prisma.adminUser.findUnique({ where: { username } });
    const passwordHash = admin?.passwordHash ?? (await this.placeholderHash());
    const matched = await verifyPassword(passwordHash, password);
    if (!admin || !matched || admin.status !== ADMIN_STATUS_ACTIVE) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const issued = await this.tokens.issue({ id: admin.id, username: admin.username });
    return {
      token: issued.token,
      tokenType: 'Bearer',
      expiresAt: issued.expiresAt.toISOString(),
      admin: {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
      },
    };
  }

  private placeholderHash(): Promise<string> {
    this.dummyHash ??= hashPassword('not-a-login-password');
    return this.dummyHash;
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
