import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { USER_STATUS_ACTIVE, USER_STATUS_DISABLED } from '../../common/auth/user-status';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { ORDER_PAID, ORDER_SHIPPED } from '../orders/order.constants';
import { PAYMENT_PURPOSE_COFOUNDER } from '../payments/wechat-pay.constants';
import { KYC_STATUS_VERIFIED } from '../users/kyc.constants';
import { KycService, type KycView } from '../users/kyc.service';

/** 订单已支付且未关闭的状态集合。closed 含退款关闭，不计入统计。 */
const PAID_ORDER_STATUSES = [ORDER_PAID, ORDER_SHIPPED];

export interface AdminUserStats {
  /** 已支付且未关闭订单的微信实付合计（分），加联合创始人开通的微信支付。 */
  paidWechatFen: number;
  /** 创业专区已支付订单笔数。 */
  startupPaidOrders: number;
  /** 商城专区已支付订单笔数。 */
  mallPaidOrders: number;
  /** 创业专区已支付商品件数（报单资格数）。 */
  startupPaidUnits: number;
  /** 商城专区已支付商品件数。 */
  mallPaidUnits: number;
  /** 直接邀请人数（邀请树上以该用户为上级的节点数）。 */
  inviteeCount: number;
}

export interface AdminUserView extends AdminUserStats {
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
    const stats = await this.collectStats(ids);
    return users.map((user) => ({
      id: user.id,
      status: user.status,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      inviteCode: user.inviteCode,
      member: user.member,
      kycVerified: verified.has(user.id.toString()),
      ...stats.get(user.id.toString()) ?? {
        paidWechatFen: 0,
        startupPaidOrders: 0,
        mallPaidOrders: 0,
        startupPaidUnits: 0,
        mallPaidUnits: 0,
        inviteeCount: 0,
      },
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    }));
  }

  /** 按用户聚合订单、邀请与开通支付统计。只查当前页用户，分页下开销可控。 */
  private async collectStats(ids: bigint[]): Promise<Map<string, AdminUserStats>> {
    const orderRows = await this.prisma.order.findMany({
      where: { userId: { in: ids }, status: { in: PAID_ORDER_STATUSES } },
    });
    const [inviteRows, activationRows, itemRows] = await Promise.all([
      this.prisma.inviteTreeNode.findMany({ where: { parentUserId: { in: ids } } }),
      this.prisma.payment.findMany({
        where: {
          userId: { in: ids },
          purpose: PAYMENT_PURPOSE_COFOUNDER,
          status: 'success',
        },
      }),
      orderRows.length > 0
        ? this.prisma.orderItem.findMany({
            where: { orderId: { in: orderRows.map((order) => order.id) } },
          })
        : Promise.resolve([]),
    ]);
    const stats = new Map<string, AdminUserStats>();
    for (const id of ids) {
      stats.set(id.toString(), {
        paidWechatFen: 0,
        startupPaidOrders: 0,
        mallPaidOrders: 0,
        startupPaidUnits: 0,
        mallPaidUnits: 0,
        inviteeCount: 0,
      });
    }
    const orderByItem = new Map(
      orderRows.map((order) => [
        order.id.toString(),
        { userId: order.userId.toString(), zone: order.zone as string },
      ]),
    );
    for (const item of itemRows) {
      const order = orderByItem.get(item.orderId.toString());
      if (!order) {
        continue;
      }
      const entry = stats.get(order.userId);
      if (!entry) {
        continue;
      }
      if (order.zone === PRODUCT_ZONE_STARTUP) {
        entry.startupPaidUnits += item.quantity;
      } else if (order.zone === PRODUCT_ZONE_MALL) {
        entry.mallPaidUnits += item.quantity;
      }
    }
    for (const order of orderRows) {
      const entry = stats.get(order.userId.toString());
      if (!entry) {
        continue;
      }
      entry.paidWechatFen += order.wechatFen;
      if (order.zone === PRODUCT_ZONE_STARTUP) {
        entry.startupPaidOrders += 1;
      } else if (order.zone === PRODUCT_ZONE_MALL) {
        entry.mallPaidOrders += 1;
      }
    }
    for (const payment of activationRows) {
      const entry = payment.userId === null ? undefined : stats.get(payment.userId.toString());
      if (entry) {
        entry.paidWechatFen += payment.amountFen;
      }
    }
    for (const node of inviteRows) {
      if (node.parentUserId === null) {
        continue;
      }
      const entry = stats.get(node.parentUserId.toString());
      if (entry) {
        entry.inviteeCount += 1;
      }
    }
    return stats;
  }
}
