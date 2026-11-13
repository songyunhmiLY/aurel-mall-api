import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OPS_TEAM_ACTIVE_SLOT,
  OPS_TEAM_SLOT,
  OPS_TEAM_STATUS_ACTIVE,
  OPS_TEAM_STATUS_CANCELLED,
  isUniqueConflict,
  type Tx,
} from './ops-team.constants';

export interface OpsTeamEnrollmentView {
  id: bigint;
  userId: bigint;
  nickname: string;
  member: boolean;
  status: string;
  enrolledAt: string;
  cancelledAt: string | null;
}

interface SeatRow {
  id: bigint;
  enrollmentId: bigint | null;
}

/**
 * 管理员指定、改派和取消运营团队。全网同时只有一名。
 * 被指定的人必须已经是会员。没有支付开通。
 * 改派时上一任立刻停止，已经入账的留在原账户。
 * 指定和取消都不改联合创始人或工作室身份，也不动钱包。
 */
@Injectable()
export class OpsTeamEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async current(): Promise<{ holder: OpsTeamEnrollmentView | null }> {
    const seat = await this.prisma.opsTeamSeat.findUnique({ where: { slot: OPS_TEAM_SLOT } });
    if (!seat?.enrollmentId) {
      return { holder: null };
    }
    const enrollment = await this.prisma.opsTeamEnrollment.findUnique({
      where: { id: seat.enrollmentId },
    });
    if (!enrollment || enrollment.status !== OPS_TEAM_STATUS_ACTIVE) {
      return { holder: null };
    }
    const user = await this.prisma.user.findUnique({ where: { id: enrollment.userId } });
    return { holder: toView(enrollment, user) };
  }

  async appoint(userId: bigint, adminId: bigint): Promise<OpsTeamEnrollmentView> {
    const now = await this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      const seat = await this.lockSeat(tx, now);
      await lockUser(tx, userId);
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('会员不存在');
      }
      if (!user.member) {
        throw new ForbiddenException('非会员不能被指定为运营团队');
      }
      const active = await this.activeEnrollment(tx, seat);
      if (active && active.userId === userId) {
        throw new ConflictException('该会员已是运营团队');
      }
      if (active) {
        await lockUser(tx, active.userId);
        await this.stop(tx, active.id, adminId, now);
      }
      let createdId: bigint;
      try {
        const created = await tx.opsTeamEnrollment.create({
          data: {
            userId,
            status: OPS_TEAM_STATUS_ACTIVE,
            appointedByAdminId: adminId,
            enrolledAt: now,
            cancelledAt: null,
            cancelledByAdminId: null,
            activeSlot: OPS_TEAM_ACTIVE_SLOT,
            createdAt: now,
            updatedAt: now,
          },
        });
        createdId = created.id;
      } catch (error) {
        if (isUniqueConflict(error)) {
          throw new ConflictException('已有运营团队');
        }
        throw error;
      }
      await tx.opsTeamSeat.update({
        where: { id: seat.id },
        data: { enrollmentId: createdId, updatedAt: now },
      });
      return createdId;
    });
    return this.requireView(id);
  }

  async cancel(adminId: bigint): Promise<OpsTeamEnrollmentView> {
    const now = await this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      const seat = await this.lockSeat(tx, now);
      const active = await this.activeEnrollment(tx, seat);
      if (!active) {
        throw new NotFoundException('当前没有运营团队');
      }
      await lockUser(tx, active.userId);
      await this.stop(tx, active.id, adminId, now);
      await tx.opsTeamSeat.update({
        where: { id: seat.id },
        data: { enrollmentId: null, updatedAt: now },
      });
      return active.id;
    });
    return this.requireView(id);
  }

  /**
   * 支付成功计提前调用。锁住席位后返回当时的持有人。
   * 没有人在籍时返回 null，调用方不入账。
   */
  async lockHolder(tx: Tx, now: Date): Promise<{ userId: bigint } | null> {
    const seat = await this.lockSeat(tx, now);
    const active = await this.activeEnrollment(tx, seat);
    if (!active) {
      return null;
    }
    return { userId: active.userId };
  }

  private async activeEnrollment(
    tx: Tx,
    seat: SeatRow,
  ): Promise<{ id: bigint; userId: bigint } | null> {
    if (seat.enrollmentId === null) {
      return null;
    }
    const enrollment = await tx.opsTeamEnrollment.findUnique({ where: { id: seat.enrollmentId } });
    if (!enrollment || enrollment.status !== OPS_TEAM_STATUS_ACTIVE) {
      return null;
    }
    return { id: enrollment.id, userId: enrollment.userId };
  }

  private async stop(tx: Tx, id: bigint, adminId: bigint, now: Date): Promise<void> {
    await tx.opsTeamEnrollment.update({
      where: { id },
      data: {
        status: OPS_TEAM_STATUS_CANCELLED,
        cancelledAt: now,
        cancelledByAdminId: adminId,
        activeSlot: null,
        updatedAt: now,
      },
    });
  }

  private async lockSeat(tx: Tx, now: Date): Promise<SeatRow> {
    const existing = await tx.opsTeamSeat.findUnique({ where: { slot: OPS_TEAM_SLOT } });
    if (!existing) {
      try {
        await tx.opsTeamSeat.create({
          data: { slot: OPS_TEAM_SLOT, enrollmentId: null, updatedAt: now },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    }
    await tx.$queryRaw`
      SELECT id FROM ops_team_seats WHERE slot = ${OPS_TEAM_SLOT} FOR UPDATE
    `;
    const row = await tx.opsTeamSeat.findUnique({ where: { slot: OPS_TEAM_SLOT } });
    if (!row) {
      throw new InternalServerErrorException('运营团队席位不存在');
    }
    return { id: row.id, enrollmentId: row.enrollmentId };
  }

  private async requireView(id: bigint): Promise<OpsTeamEnrollmentView> {
    const found = await this.prisma.opsTeamEnrollment.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException('当前没有运营团队');
    }
    const user = await this.prisma.user.findUnique({ where: { id: found.userId } });
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
): OpsTeamEnrollmentView {
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
