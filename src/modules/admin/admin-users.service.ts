import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { USER_STATUS_ACTIVE, USER_STATUS_DISABLED } from '../../common/auth/user-status';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PRODUCT_ZONE_MALL, PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { COFOUNDER_STATUS_ACTIVE } from '../cofounder/cofounder.constants';
import { OPS_TEAM_STATUS_ACTIVE } from '../ops-team/ops-team.constants';
import { ORDER_PAID, ORDER_SHIPPED } from '../orders/order.constants';
import { STUDIO_STATUS_ACTIVE } from '../studio/studio.constants';
import { WITHDRAWAL_PAID } from '../wallet/wallet.constants';
import { KYC_STATUS_VERIFIED } from '../users/kyc.constants';
import { KycService, type KycView } from '../users/kyc.service';

/** 订单已支付且未关闭的状态集合。closed 含退款关闭，不计入统计。 */
const PAID_ORDER_STATUSES = [ORDER_PAID, ORDER_SHIPPED];

const WALLET_WITHDRAWABLE = 'withdrawable';
const WALLET_POINTS = 'points';
const WALLET_CONSUMPTION = 'consumption';

export interface AdminUserStats {
  /** 创业专区微信实付合计（分）。 */
  startupPaidFen: number;
  /** 创业专区下单总金额（应付，含运费与积分/余额抵扣部分，分）。 */
  startupPayableFen: number;
  /** 商城专区微信实付合计（分）。 */
  mallPaidFen: number;
  /** 商城专区下单总金额（应付，分）。 */
  mallPayableFen: number;
  /** 创业专区已支付订单笔数。 */
  startupPaidOrders: number;
  /** 商城专区已支付订单笔数。 */
  mallPaidOrders: number;
  /** 创业专区已支付商品件数（报单资格数）。 */
  startupPaidUnits: number;
  /** 商城专区已支付商品件数。 */
  mallPaidUnits: number;
  /** 可提现账户余额（分，含冻结）。 */
  withdrawableBalanceFen: number;
  /** 积分账户余额（分，含冻结）。 */
  pointsBalanceFen: number;
  /** 消费金账户余额（分，含冻结）。 */
  consumptionBalanceFen: number;
  /** 累计提现金额（分，按已打款结算单合计）。 */
  totalWithdrawnFen: number;
  /** 直接邀请人数（邀请树上以该用户为上级的节点数）。 */
  inviteeCount: number;
  /** 附加身份（会员/普通为基底，不在其中）。 */
  identities: string[];
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
    const [kycRows, stats] = await Promise.all([
      this.prisma.userKyc.findMany({
        where: { userId: { in: ids }, status: KYC_STATUS_VERIFIED },
      }),
      this.collectStats(ids, users),
    ]);
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
      ...(stats.get(user.id.toString()) ?? emptyStats()),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    }));
  }

  /**
   * 按当前页用户聚合订单、钱包、身份与提现统计。
   * 钱包余额本身已物化在 wallet_accounts；订单/提现/身份走页级索引查询，
   * 不在用户表上冗余计数（写入点太多，容易与真实流水不一致）。
   */
  private async collectStats(
    ids: bigint[],
    users: User[],
  ): Promise<Map<string, AdminUserStats>> {
    const seatedById = new Map(users.map((user) => [user.id.toString(), user.seated]));
    const stats = new Map<string, AdminUserStats>();
    for (const id of ids) {
      stats.set(id.toString(), emptyStats());
    }
    await this.collectOrders(ids, stats);
    await this.collectWallets(ids, stats);
    await this.collectIdentities(ids, seatedById, stats);
    await this.collectWithdrawn(ids, stats);
    await this.collectInvitees(ids, stats);
    return stats;
  }

  private async collectOrders(
    ids: bigint[],
    stats: Map<string, AdminUserStats>,
  ): Promise<void> {
    const orderRows = await this.prisma.order.findMany({
      where: { userId: { in: ids }, status: { in: PAID_ORDER_STATUSES } },
    });
    const itemRows =
      orderRows.length > 0
        ? await this.prisma.orderItem.findMany({
            where: { orderId: { in: orderRows.map((order) => order.id) } },
          })
        : [];
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
      if (order.zone === PRODUCT_ZONE_STARTUP) {
        entry.startupPaidOrders += 1;
        entry.startupPaidFen += order.wechatFen;
        entry.startupPayableFen += order.payAmountFen;
      } else if (order.zone === PRODUCT_ZONE_MALL) {
        entry.mallPaidOrders += 1;
        entry.mallPaidFen += order.wechatFen;
        entry.mallPayableFen += order.payAmountFen;
      }
    }
  }

  private async collectWallets(
    ids: bigint[],
    stats: Map<string, AdminUserStats>,
  ): Promise<void> {
    const wallets = await this.prisma.walletAccount.findMany({
      where: { userId: { in: ids } },
    });
    for (const wallet of wallets) {
      const entry = stats.get(wallet.userId.toString());
      if (!entry) {
        continue;
      }
      const balance = Number(wallet.balanceFen);
      if (wallet.walletType === WALLET_WITHDRAWABLE) {
        entry.withdrawableBalanceFen = balance;
      } else if (wallet.walletType === WALLET_POINTS) {
        entry.pointsBalanceFen = balance;
      } else if (wallet.walletType === WALLET_CONSUMPTION) {
        entry.consumptionBalanceFen = balance;
      }
    }
  }

  private async collectIdentities(
    ids: bigint[],
    seatedById: Map<string, boolean>,
    stats: Map<string, AdminUserStats>,
  ): Promise<void> {
    // 身份基底：已入座=会员，未入座=普通。联创/工作室/运营团队按在籍记录叠加。
    for (const [id, seated] of seatedById) {
      const entry = stats.get(id);
      if (entry) {
        entry.identities = seated ? ['member'] : ['normal'];
      }
    }
    const [cofounders, studios, opsTeam] = await Promise.all([
      this.prisma.cofounderEnrollment.findMany({
        where: { userId: { in: ids }, status: COFOUNDER_STATUS_ACTIVE },
      }),
      this.prisma.studioEnrollment.findMany({
        where: { userId: { in: ids }, status: STUDIO_STATUS_ACTIVE },
      }),
      this.prisma.opsTeamEnrollment.findMany({
        where: { userId: { in: ids }, status: OPS_TEAM_STATUS_ACTIVE },
      }),
    ]);
    for (const row of cofounders) {
      const entry = stats.get(row.userId.toString());
      if (entry && !entry.identities.includes('cofounder')) {
        entry.identities.push('cofounder');
      }
    }
    for (const row of studios) {
      const entry = stats.get(row.userId.toString());
      if (entry && !entry.identities.includes('studio')) {
        entry.identities.push('studio');
      }
    }
    for (const row of opsTeam) {
      const entry = stats.get(row.userId.toString());
      if (entry && !entry.identities.includes('ops_team')) {
        entry.identities.push('ops_team');
      }
    }
  }

  private async collectWithdrawn(
    ids: bigint[],
    stats: Map<string, AdminUserStats>,
  ): Promise<void> {
    const settlements = await this.prisma.withdrawalSettlement.findMany({
      where: { userId: { in: ids }, outcome: WITHDRAWAL_PAID },
    });
    for (const row of settlements) {
      const entry = stats.get(row.userId.toString());
      if (entry) {
        entry.totalWithdrawnFen += Number(row.amountFen);
      }
    }
  }

  private async collectInvitees(
    ids: bigint[],
    stats: Map<string, AdminUserStats>,
  ): Promise<void> {
    const inviteRows = await this.prisma.inviteTreeNode.findMany({
      where: { parentUserId: { in: ids } },
    });
    for (const node of inviteRows) {
      if (node.parentUserId === null) {
        continue;
      }
      const entry = stats.get(node.parentUserId.toString());
      if (entry) {
        entry.inviteeCount += 1;
      }
    }
  }
}

function emptyStats(): AdminUserStats {
  return {
    startupPaidFen: 0,
    startupPayableFen: 0,
    mallPaidFen: 0,
    mallPayableFen: 0,
    startupPaidOrders: 0,
    mallPaidOrders: 0,
    startupPaidUnits: 0,
    mallPaidUnits: 0,
    withdrawableBalanceFen: 0,
    pointsBalanceFen: 0,
    consumptionBalanceFen: 0,
    totalWithdrawnFen: 0,
    inviteeCount: 0,
    identities: ['normal'],
  };
}
