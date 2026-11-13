import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { USER_STATUS_ACTIVE } from '../../common/auth/user-status';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CashLedgerService } from '../wallet/cash-ledger.service';
import { CASH_COFOUNDER_ACTIVATION } from '../wallet/wallet.constants';
import {
  CofounderActivationSettler,
  type CofounderPaymentEvent,
} from './cofounder-activation.settler';
import { CofounderPoolService } from './cofounder-pool.service';
import { CofounderSettingsService } from './cofounder-settings.service';
import {
  ACTIVATION_FAILED,
  ACTIVATION_PENDING,
  ACTIVATION_SUCCEEDED,
  BUTTON_ALREADY,
  BUTTON_AMOUNT_UNSET,
  BUTTON_CAP_FULL,
  BUTTON_CLOSED,
  BUTTON_NOT_MEMBER,
  BUTTON_OPEN,
  COFOUNDER_SOURCE_APPOINTMENT,
  COFOUNDER_SOURCE_PAYMENT,
  COFOUNDER_STATUS_ACTIVE,
  COFOUNDER_STATUS_CANCELLED,
  type Tx,
} from './cofounder.constants';

export interface CofounderButton {
  available: boolean;
  reason: string;
}

export interface CofounderMemberPage {
  entry: { copy: string; imageUrls: string[] };
  intro: { title: string; body: string; imageUrls: string[] };
  enrolled: boolean;
  enrolledAt: string | null;
  source: string | null;
  button: CofounderButton;
  seatCap: number;
  enrolledCount: number;
  activationAmountFen: bigint;
  pendingActivation: {
    id: bigint;
    payNo: string | null;
    amountFen: number;
    status: string;
  } | null;
}

export interface EnrollmentView {
  id: bigint;
  userId: bigint;
  nickname: string;
  member: boolean;
  status: string;
  source: string;
  enrolledAt: string;
  cancelledAt: string | null;
}

/**
 * 在籍、指定、取消和支付开通入籍。
 * 取消只改身份，并把用户端按钮关掉。不退款，不动钱包。
 * 名额满了之后用户按钮不可用，管理员仍可指定，在籍人数可以超过上限。
 * 有人退出后按钮不会自己打开。
 */
@Injectable()
export class CofounderEnrollmentService extends CofounderActivationSettler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly pool: CofounderPoolService,
    private readonly settings: CofounderSettingsService,
    private readonly cash: CashLedgerService,
  ) {
    super();
  }

  async pageFor(userId: bigint): Promise<CofounderMemberPage> {
    const [content, settings, user, enrollment, enrolledCount, pending] = await Promise.all([
      this.settings.getContent(),
      this.settings.get(),
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.cofounderEnrollment.findFirst({
        where: { userId, status: COFOUNDER_STATUS_ACTIVE },
        orderBy: { id: 'desc' },
      }),
      this.prisma.cofounderEnrollment.count({ where: { status: COFOUNDER_STATUS_ACTIVE } }),
      this.prisma.cofounderActivation.findFirst({
        where: { userId, status: ACTIVATION_PENDING },
        orderBy: { id: 'desc' },
      }),
    ]);
    let pendingActivation: CofounderMemberPage['pendingActivation'] = null;
    if (pending) {
      const payment = await this.prisma.payment.findUnique({ where: { id: pending.paymentId } });
      pendingActivation = {
        id: pending.id,
        payNo: payment?.payNo ?? null,
        amountFen: pending.amountFen,
        status: pending.status,
      };
    }
    return {
      entry: { copy: content.entryCopy, imageUrls: content.entryImageUrls },
      intro: {
        title: content.introTitle,
        body: content.introBody,
        imageUrls: content.introImageUrls,
      },
      enrolled: enrollment !== null,
      enrolledAt: enrollment ? enrollment.enrolledAt.toISOString() : null,
      source: enrollment?.source ?? null,
      button: describeButton({
        enrolled: enrollment !== null,
        member: user?.member === true,
        enrolledCount,
        seatCap: settings.seatCap,
        userButtonOpen: settings.userButtonOpen,
        activationAmountFen: settings.activationAmountFen,
      }),
      seatCap: settings.seatCap,
      enrolledCount,
      activationAmountFen: settings.activationAmountFen,
      pendingActivation,
    };
  }

  async list(query: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: EnrollmentView[]; total: number; page: number; pageSize: number }> {
    const where = query.status ? { status: query.status } : {};
    const [total, rows] = await Promise.all([
      this.prisma.cofounderEnrollment.count({ where }),
      this.prisma.cofounderEnrollment.findMany({
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
      items: rows.map((row) => {
        const user = byId.get(row.userId.toString());
        return {
          id: row.id,
          userId: row.userId,
          nickname: user?.nickname ?? '',
          member: user?.member === true,
          status: row.status,
          source: row.source,
          enrolledAt: row.enrolledAt.toISOString(),
          cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async appoint(userId: bigint, adminId: bigint): Promise<EnrollmentView> {
    const now = await this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await this.pool.lock(tx, now);
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('会员不存在');
      }
      if (!user.member) {
        throw new ForbiddenException('非会员不能被指定为联合创始人');
      }
      const active = await tx.cofounderEnrollment.findFirst({
        where: { userId, status: COFOUNDER_STATUS_ACTIVE },
      });
      if (active) {
        throw new ConflictException('该会员已是联合创始人');
      }
      const created = await tx.cofounderEnrollment.create({
        data: {
          userId,
          status: COFOUNDER_STATUS_ACTIVE,
          source: COFOUNDER_SOURCE_APPOINTMENT,
          activationId: null,
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
    const found = await this.prisma.cofounderEnrollment.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException('联合创始人不存在');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      id: found.id,
      userId: found.userId,
      nickname: user?.nickname ?? '',
      member: user?.member === true,
      status: found.status,
      source: found.source,
      enrolledAt: found.enrolledAt.toISOString(),
      cancelledAt: null,
    };
  }

  async cancel(userId: bigint, adminId: bigint): Promise<EnrollmentView> {
    const now = await this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await this.pool.lock(tx, now);
      const active = await tx.cofounderEnrollment.findFirst({
        where: { userId, status: COFOUNDER_STATUS_ACTIVE },
        orderBy: { id: 'desc' },
      });
      if (!active) {
        throw new NotFoundException('该会员不是联合创始人');
      }
      await tx.cofounderEnrollment.update({
        where: { id: active.id },
        data: {
          status: COFOUNDER_STATUS_CANCELLED,
          cancelledAt: now,
          cancelledByAdminId: adminId,
          updatedAt: now,
        },
      });
      await this.settings.closeUserButton(tx, adminId, now);
      return active.id;
    });
    const found = await this.prisma.cofounderEnrollment.findUnique({ where: { id } });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!found) {
      throw new NotFoundException('该会员不是联合创始人');
    }
    return {
      id: found.id,
      userId: found.userId,
      nickname: user?.nickname ?? '',
      member: user?.member === true,
      status: found.status,
      source: found.source,
      enrolledAt: found.enrolledAt.toISOString(),
      cancelledAt: found.cancelledAt ? found.cancelledAt.toISOString() : null,
    };
  }

  /**
   * 调用方已经锁住池子。返回本次应支付的分。
   * 金额还没配置、名额已满或按钮关闭时不能发起支付。
   */
  async assertPayable(tx: Tx, userId: bigint): Promise<number> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== USER_STATUS_ACTIVE) {
      throw new UnauthorizedException('登录已失效');
    }
    if (!user.member) {
      throw new ForbiddenException('非会员不能开通联合创始人');
    }
    const active = await tx.cofounderEnrollment.findFirst({
      where: { userId, status: COFOUNDER_STATUS_ACTIVE },
    });
    if (active) {
      throw new ConflictException('你已是联合创始人');
    }
    const settings = await this.settings.readFrom(tx);
    const enrolledCount = await tx.cofounderEnrollment.count({
      where: { status: COFOUNDER_STATUS_ACTIVE },
    });
    const button = describeButton({
      enrolled: false,
      member: true,
      enrolledCount,
      seatCap: settings.seatCap,
      userButtonOpen: settings.userButtonOpen,
      activationAmountFen: settings.activationAmountFen,
    });
    if (!button.available) {
      throw new ConflictException(buttonMessage(button.reason));
    }
    return Number(settings.activationAmountFen);
  }

  async attachActivation(tx: Tx, userId: bigint, paymentId: bigint, amountFen: number, now: Date) {
    const existing = await tx.cofounderActivation.findUnique({ where: { paymentId } });
    if (existing) {
      return existing;
    }
    return tx.cofounderActivation.create({
      data: {
        userId,
        amountFen,
        status: ACTIVATION_PENDING,
        paymentId,
        succeededAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  override async onPaymentFinished(tx: Tx, event: CofounderPaymentEvent): Promise<void> {
    await this.pool.lock(tx, event.now);
    const activation = await tx.cofounderActivation.findUnique({
      where: { paymentId: event.paymentId },
    });
    if (!activation || activation.userId !== event.userId) {
      throw new NotFoundException('开通单不存在');
    }
    if (activation.amountFen !== event.amountFen) {
      throw new ConflictException('支付金额不一致');
    }
    if (activation.status === ACTIVATION_SUCCEEDED) {
      return;
    }
    if (!event.succeeded) {
      await tx.cofounderActivation.update({
        where: { id: activation.id },
        data: { status: ACTIVATION_FAILED, updatedAt: event.now },
      });
      return;
    }
    await this.cash.recordInflow(tx, {
      amountFen: BigInt(activation.amountFen),
      bizType: CASH_COFOUNDER_ACTIVATION,
      bizId: event.paymentId.toString(),
      occurredAt: event.now,
    });
    const active = await tx.cofounderEnrollment.findFirst({
      where: { userId: event.userId, status: COFOUNDER_STATUS_ACTIVE },
    });
    if (!active) {
      await tx.cofounderEnrollment.create({
        data: {
          userId: event.userId,
          status: COFOUNDER_STATUS_ACTIVE,
          source: COFOUNDER_SOURCE_PAYMENT,
          activationId: activation.id,
          appointedByAdminId: null,
          enrolledAt: event.now,
          cancelledAt: null,
          cancelledByAdminId: null,
          createdAt: event.now,
          updatedAt: event.now,
        },
      });
    }
    await tx.cofounderActivation.update({
      where: { id: activation.id },
      data: { status: ACTIVATION_SUCCEEDED, succeededAt: event.now, updatedAt: event.now },
    });
  }
}

export function describeButton(input: {
  enrolled: boolean;
  member: boolean;
  enrolledCount: number;
  seatCap: number;
  userButtonOpen: boolean;
  activationAmountFen: bigint;
}): CofounderButton {
  if (input.enrolled) {
    return { available: false, reason: BUTTON_ALREADY };
  }
  if (!input.member) {
    return { available: false, reason: BUTTON_NOT_MEMBER };
  }
  if (input.enrolledCount >= input.seatCap) {
    return { available: false, reason: BUTTON_CAP_FULL };
  }
  if (!input.userButtonOpen) {
    return { available: false, reason: BUTTON_CLOSED };
  }
  if (input.activationAmountFen <= 0n) {
    return { available: false, reason: BUTTON_AMOUNT_UNSET };
  }
  return { available: true, reason: BUTTON_OPEN };
}

function buttonMessage(reason: string): string {
  if (reason === BUTTON_CAP_FULL) {
    return '联合创始人名额已满';
  }
  if (reason === BUTTON_AMOUNT_UNSET) {
    return '尚未设置开通金额';
  }
  if (reason === BUTTON_ALREADY) {
    return '你已是联合创始人';
  }
  return '成为联合创始人暂未开放';
}
