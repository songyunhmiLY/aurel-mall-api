import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STUDIO_STATUS_ACTIVE, STUDIO_STATUS_CANCELLED, type Tx } from './studio.constants';

export interface StudioEnrollmentView {
  id: bigint;
  userId: bigint;
  nickname: string;
  member: boolean;
  status: string;
  enrolledAt: string;
  cancelledAt: string | null;
}

/**
 * 管理员指定和取消工作室。没有人数上限，也没有支付开通。
 * 被指定的人必须已经是会员。取消只改身份，不退款，不动钱包。
 * 指定不会改联合创始人身份。
 */
@Injectable()
export class StudioEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async list(query: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: StudioEnrollmentView[]; total: number; page: number; pageSize: number }> {
    const where = query.status ? { status: query.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.studioEnrollment.count({ where }),
      this.prisma.studioEnrollment.findMany({
        where,
        orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.userId) } },
    });
    const byId = new Map(users.map((user) => [user.id.toString(), user]));
    return {
      items: rows.map((row) => toView(row, byId.get(row.userId.toString()))),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async appoint(userId: bigint, adminId: bigint): Promise<StudioEnrollmentView> {
    const now = await this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('会员不存在');
      }
      if (!user.member) {
        throw new ForbiddenException('非会员不能被指定为工作室');
      }
      const active = await tx.studioEnrollment.findFirst({
        where: { userId, status: STUDIO_STATUS_ACTIVE },
      });
      if (active) {
        throw new ConflictException('该会员已是工作室');
      }
      const created = await tx.studioEnrollment.create({
        data: {
          userId,
          status: STUDIO_STATUS_ACTIVE,
          appointedByAdminId: adminId,
          enrolledAt: now,
          cancelledAt: null,
          cancelledByAdminId: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      return created.id;
    });
    return this.requireView(id, userId);
  }

  async cancel(userId: bigint, adminId: bigint): Promise<StudioEnrollmentView> {
    const now = await this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const active = await tx.studioEnrollment.findFirst({
        where: { userId, status: STUDIO_STATUS_ACTIVE },
        orderBy: { id: 'desc' },
      });
      if (!active) {
        throw new NotFoundException('该会员不是工作室');
      }
      await tx.studioEnrollment.update({
        where: { id: active.id },
        data: {
          status: STUDIO_STATUS_CANCELLED,
          cancelledAt: now,
          cancelledByAdminId: adminId,
          updatedAt: now,
        },
      });
      return active.id;
    });
    return this.requireView(id, userId);
  }

  private async requireView(id: bigint, userId: bigint): Promise<StudioEnrollmentView> {
    const found = await this.prisma.studioEnrollment.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException('该会员不是工作室');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return toView(found, user);
  }
}

function lockUser(tx: Tx, userId: bigint): Promise<unknown> {
  return tx.$queryRaw`
    SELECT id FROM users WHERE id = ${userId} FOR UPDATE
  `;
}

function toView(
  row: {
    id: bigint;
    userId: bigint;
    status: string;
    enrolledAt: Date;
    cancelledAt: Date | null;
  },
  user: { nickname: string; member: boolean } | null | undefined,
): StudioEnrollmentView {
  return {
    id: row.id,
    userId: row.userId,
    nickname: user?.nickname ?? '',
    member: user?.member === true,
    status: row.status,
    enrolledAt: row.enrolledAt.toISOString(),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}
