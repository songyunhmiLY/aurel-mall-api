import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import type { User, UserIdentity } from '@prisma/client';
import { MiniProgramTokenService } from '../../common/auth/mini-program-token.service';
import { USER_STATUS_ACTIVE } from '../../common/auth/user-status';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AppEnv } from '../../config/app-env';
import { APP_ENV } from '../../config/tokens';
import {
  IDENTITY_PROVIDERS,
  ROOT_IDENTITY_IDENTIFIER,
  ROOT_INVITE_CODE,
  ROOT_NICKNAME,
} from './identity.constants';
import { WechatMiniClient } from './wechat-mini.client';

export interface UserSessionView {
  id: bigint;
  nickname: string;
  avatarUrl: string | null;
  phone: string | null;
  inviteCode: string | null;
  member: boolean;
  status: string;
}

export interface UserSessionResult {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
  user: UserSessionView;
}

const PREVIEW_SUBJECT = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 小程序登录、开发预览登录、手机号绑定，以及官方根账户。
 * 会员 = 市场树有席位。本阶段只预置根账户，不给其他用户安置席位。
 */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly tokens: MiniProgramTokenService,
    private readonly wechat: WechatMiniClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.findRootIdentity();
    if (existing) {
      this.logger.log('system root account already exists');
      return;
    }
    const now = await this.clock.now();
    try {
      await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            status: USER_STATUS_ACTIVE,
            nickname: ROOT_NICKNAME,
            avatarUrl: null,
            phone: null,
            inviteCode: ROOT_INVITE_CODE,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.userIdentity.create({
          data: {
            userId: user.id,
            provider: IDENTITY_PROVIDERS.systemRoot,
            identifier: ROOT_IDENTITY_IDENTIFIER,
            unionId: null,
            createdAt: now,
          },
        });
        const path = `/${user.id.toString()}/`;
        await tx.inviteTreeNode.create({
          data: {
            userId: user.id,
            parentUserId: null,
            depth: 0,
            path,
            joinedAt: now,
          },
        });
        await tx.marketTreeNode.create({
          data: {
            userId: user.id,
            parentUserId: null,
            depth: 0,
            path,
            placedAt: now,
          },
        });
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const raced = await this.findRootIdentity();
        if (raced) {
          return;
        }
      }
      throw error;
    }
    this.logger.log('bootstrapped system root account');
  }

  /** 有市场树席位才是会员。根账户启动时已入座，其他用户本阶段不会入座。 */
  async isMember(userId: bigint): Promise<boolean> {
    const seat = await this.prisma.marketTreeNode.findUnique({ where: { userId } });
    return seat !== null;
  }

  async loginWithMiniProgram(code: string): Promise<UserSessionResult> {
    const trimmed = code.trim();
    if (trimmed.length < 1 || trimmed.length > 128) {
      throw new BadRequestException('登录码不正确');
    }
    const session = await this.wechat.exchangeLoginCode(trimmed);
    const identity = await this.findIdentity(IDENTITY_PROVIDERS.wechatMini, session.openid);
    if (identity) {
      const user = await this.requireActiveUser(identity.userId);
      if (session.unionid && identity.unionId !== session.unionid) {
        // 只记在这条 openid 身份上，不按 unionid 查找或合并其他用户。
        await this.prisma.userIdentity.update({
          where: { id: identity.id },
          data: { unionId: session.unionid },
        });
      }
      return this.issue(user);
    }
    const now = await this.clock.now();
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            status: USER_STATUS_ACTIVE,
            nickname: '微信用户',
            avatarUrl: null,
            phone: null,
            inviteCode: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.userIdentity.create({
          data: {
            userId: created.id,
            provider: IDENTITY_PROVIDERS.wechatMini,
            identifier: session.openid,
            unionId: session.unionid,
            createdAt: now,
          },
        });
        return created;
      });
      return this.issue(user);
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const raced = await this.findIdentity(IDENTITY_PROVIDERS.wechatMini, session.openid);
      if (!raced) {
        throw error;
      }
      const user = await this.requireActiveUser(raced.userId);
      return this.issue(user);
    }
  }

  /**
   * 开发预览身份。开关关闭时直接拒绝，不看主机名或来源 IP，也不创建用户。
   * 不代替 wx.login，也不走微信网站应用 OAuth。
   */
  async loginPreview(subject: string): Promise<UserSessionResult> {
    if (!this.env.allowPreviewAuth) {
      throw new ForbiddenException('预览登录未启用，本次操作已忽略');
    }
    const identifier = subject.trim();
    if (!PREVIEW_SUBJECT.test(identifier)) {
      throw new BadRequestException('预览身份标识不正确');
    }
    const identity = await this.findIdentity(IDENTITY_PROVIDERS.preview, identifier);
    if (identity) {
      const user = await this.requireActiveUser(identity.userId);
      return this.issue(user);
    }
    const now = await this.clock.now();
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            status: USER_STATUS_ACTIVE,
            nickname: identifier,
            avatarUrl: null,
            phone: null,
            inviteCode: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.userIdentity.create({
          data: {
            userId: created.id,
            provider: IDENTITY_PROVIDERS.preview,
            identifier,
            unionId: null,
            createdAt: now,
          },
        });
        return created;
      });
      return this.issue(user);
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      const raced = await this.findIdentity(IDENTITY_PROVIDERS.preview, identifier);
      if (!raced) {
        throw error;
      }
      const user = await this.requireActiveUser(raced.userId);
      return this.issue(user);
    }
  }

  /**
   * 把微信手机号组件返回的号码写到当前用户。
   * 不把手机号当成登录键，也不按手机号合并其他账号。
   */
  async bindWechatPhone(userId: bigint, code: string): Promise<{ phone: string }> {
    const trimmed = code.trim();
    if (trimmed.length < 1 || trimmed.length > 256) {
      throw new BadRequestException('手机号凭证不正确');
    }
    const phone = await this.wechat.exchangePhoneCode(trimmed);
    const now = await this.clock.now();
    await this.prisma.user.update({
      where: { id: userId },
      data: { phone, updatedAt: now },
    });
    return { phone };
  }

  private async issue(user: User): Promise<UserSessionResult> {
    const issued = await this.tokens.issue(user.id);
    return {
      token: issued.token,
      tokenType: 'Bearer',
      expiresAt: issued.expiresAt.toISOString(),
      user: {
        id: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        phone: user.phone,
        inviteCode: user.inviteCode,
        member: await this.isMember(user.id),
        status: user.status,
      },
    };
  }

  private async requireActiveUser(userId: bigint): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== USER_STATUS_ACTIVE) {
      throw new UnauthorizedException('账号已停用');
    }
    return user;
  }

  private findIdentity(provider: string, identifier: string): Promise<UserIdentity | null> {
    return this.prisma.userIdentity.findUnique({
      where: { provider_identifier: { provider, identifier } },
    });
  }

  private findRootIdentity(): Promise<UserIdentity | null> {
    return this.findIdentity(IDENTITY_PROVIDERS.systemRoot, ROOT_IDENTITY_IDENTIFIER);
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
