import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { USER_STATUS_ACTIVE, USER_STATUS_DISABLED } from '../../common/auth/user-status';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KYC_STATUS_VERIFIED } from '../users/kyc.constants';
import { KycService, type KycView } from '../users/kyc.service';

export interface AdminUserView {
  id: bigint;
  status: string;
  nickname: string;
  avatarUrl: string | null;
  phone: string | null;
  inviteCode: string | null;
  member: boolean;
  kycVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserPage {
  items: AdminUserView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 停用只把 status 改成 disabled，使用户不能登录。
 * 不取消会员，不删除市场树席位，也不做奖励冲正。
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly kyc: KycService,
  ) {}

  async list(query: {
    id?: bigint;
    nickname?: string;
    phone?: string;
    page: number;
    pageSize: number;
  }): Promise<AdminUserPage> {
    const where: Prisma.UserWhereInput = {};
    if (query.id !== undefined) {
      where.id = query.id;
    }
    if (query.nickname) {
      where.nickname = { contains: query.nickname };
    }
    if (query.phone) {
      where.phone = query.phone;
    }
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: await this.decorate(rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: bigint): Promise<AdminUserView> {
    const user = await this.requireUser(id);
    const [view] = await this.decorate([user]);
    if (!view) {
      throw new NotFoundException('用户不存在');
    }
    return view;
  }

  async disable(id: bigint): Promise<AdminUserView> {
    return this.setStatus(id, USER_STATUS_DISABLED);
  }

  async enable(id: bigint): Promise<AdminUserView> {
    return this.setStatus(id, USER_STATUS_ACTIVE);
  }

  async getKyc(id: bigint): Promise<KycView> {
    await this.requireUser(id);
    return this.kyc.getForUser(id);
  }

  private async setStatus(id: bigint, status: string): Promise<AdminUserView> {
    const user = await this.requireUser(id);
    const now = await this.clock.now();
    const updated =
      user.status === status
        ? user
        : await this.prisma.user.update({
            where: { id },
            data: { status, updatedAt: now },
          });
    const [view] = await this.decorate([updated]);
    if (!view) {
      throw new NotFoundException('用户不存在');
    }
    return view;
  }

  private async requireUser(id: bigint): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  private async decorate(users: User[]): Promise<AdminUserView[]> {
    if (users.length === 0) {
      return [];
    }
    const ids = users.map((user) => user.id);
    const kycRows = await this.prisma.userKyc.findMany({
      where: { userId: { in: ids }, status: KYC_STATUS_VERIFIED },
    });
    const verified = new Set(kycRows.map((row) => row.userId.toString()));
    return users.map((user) => ({
      id: user.id,
      status: user.status,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      inviteCode: user.inviteCode,
      member: user.member,
      kycVerified: verified.has(user.id.toString()),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    }));
  }
}
