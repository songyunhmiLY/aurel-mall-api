import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { InviteTreeNode, User } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketPerformanceService } from '../market-performance.service';

const MAX_WALK = 10_000;
const MAX_DEPTH = 20;

export interface PersonView {
  userId: bigint;
  nickname: string;
  inviteCode: string | null;
  member: boolean;
}

export interface InviteView {
  user: PersonView;
  inviter: PersonView | null;
  directInvitees: Array<PersonView & { joinedAt: Date }>;
}

export interface InviteChainItem extends PersonView {
  parentUserId: bigint | null;
  depth: number;
}

export interface MarketMemberView {
  userId: bigint;
  nickname: string;
  depth: number;
  placedAt: Date;
}

export interface MarketBranchView {
  userId: bigint;
  nickname: string;
  placedAt: Date;
  memberCount: number;
  members: MarketMemberView[];
}

export interface MarketTreeView {
  userId: bigint;
  seated: boolean;
  depth: number | null;
  placedAt: Date | null;
  parent: PersonView | null;
  markets: MarketBranchView[];
}

/**
 * 管理端查看邀请关系和市场树。会员端创业团队接口不使用这些字段名。
 */
@Injectable()
export class NetworkAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly performance: MarketPerformanceService,
  ) {}

  async invite(userId: bigint): Promise<InviteView> {
    const user = await this.requireUser(userId);
    const node = await this.prisma.inviteTreeNode.findUnique({ where: { userId } });
    const users = await this.prisma.user.findMany();
    const byId = new Map(users.map((row) => [row.id.toString(), row]));
    const inviter = node?.parentUserId
      ? { ...person(byId.get(node.parentUserId.toString())), userId: node.parentUserId }
      : null;
    const children = node
      ? await this.prisma.inviteTreeNode.findMany({ where: { parentUserId: userId } })
      : [];
    const directInvitees = children
      .sort((left, right) => compareJoined(left, right))
      .map((child) => ({
        ...person(byId.get(child.userId.toString())),
        userId: child.userId,
        joinedAt: child.joinedAt,
      }));
    return { user: person(user), inviter, directInvitees };
  }

  async ancestors(userId: bigint): Promise<{ items: InviteChainItem[] }> {
    await this.requireUser(userId);
    const nodes = await this.prisma.inviteTreeNode.findMany();
    const users = await this.prisma.user.findMany();
    const byUser = new Map(nodes.map((node) => [node.userId.toString(), node]));
    const byId = new Map(users.map((row) => [row.id.toString(), row]));
    const items: InviteChainItem[] = [];
    let current = byUser.get(userId.toString());
    const seen = new Set<string>();
    while (current?.parentUserId) {
      const parentId = current.parentUserId.toString();
      if (seen.has(parentId) || items.length >= MAX_WALK) {
        break;
      }
      seen.add(parentId);
      const parent = byUser.get(parentId);
      const row = byId.get(parentId);
      items.push({
        ...person(row),
        userId: current.parentUserId,
        parentUserId: parent?.parentUserId ?? null,
        depth: parent?.depth ?? items.length + 1,
      });
      current = parent;
    }
    return { items };
  }

  async descendants(
    userId: bigint,
    depth: number,
  ): Promise<{ depth: number; items: InviteChainItem[] }> {
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
      throw new BadRequestException('层数不正确');
    }
    await this.requireUser(userId);
    const nodes = await this.prisma.inviteTreeNode.findMany();
    const users = await this.prisma.user.findMany();
    const byId = new Map(users.map((row) => [row.id.toString(), row]));
    const children = new Map<string, InviteTreeNode[]>();
    for (const node of nodes) {
      if (node.parentUserId === null) {
        continue;
      }
      const key = node.parentUserId.toString();
      const list = children.get(key) ?? [];
      list.push(node);
      children.set(key, list);
    }
    const items: InviteChainItem[] = [];
    const queue: Array<{ userId: bigint; depth: number }> = [{ userId, depth: 0 }];
    const seen = new Set<string>([userId.toString()]);
    while (queue.length > 0 && items.length < MAX_WALK) {
      const current = queue.shift();
      if (!current || current.depth >= depth) {
        continue;
      }
      const next = [...(children.get(current.userId.toString()) ?? [])].sort(compareJoined);
      for (const child of next) {
        const key = child.userId.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push({
          ...person(byId.get(key)),
          userId: child.userId,
          parentUserId: child.parentUserId,
          depth: current.depth + 1,
        });
        queue.push({ userId: child.userId, depth: current.depth + 1 });
      }
    }
    return { depth, items };
  }

  async marketTree(userId: bigint): Promise<MarketTreeView> {
    await this.requireUser(userId);
    const nodes = await this.performance.loadNodes();
    const users = await this.prisma.user.findMany();
    const byId = new Map(users.map((row) => [row.id.toString(), row]));
    const seat = nodes.find((node) => node.userId === userId) ?? null;
    if (!seat) {
      return {
        userId,
        seated: false,
        depth: null,
        placedAt: null,
        parent: null,
        markets: [],
      };
    }
    const markets = this.performance.directChildren(nodes, userId).map((market) => {
      const members = nodes
        .filter((node) => node.path.startsWith(market.path))
        .sort((left, right) => left.depth - right.depth || compareId(left.userId, right.userId))
        .map((node) => ({
          userId: node.userId,
          nickname: byId.get(node.userId.toString())?.nickname ?? '会员',
          depth: node.depth,
          placedAt: node.placedAt,
        }));
      return {
        userId: market.userId,
        nickname: byId.get(market.userId.toString())?.nickname ?? '会员',
        placedAt: market.placedAt,
        memberCount: members.length,
        members,
      };
    });
    return {
      userId,
      seated: true,
      depth: seat.depth,
      placedAt: seat.placedAt,
      parent: seat.parentUserId ? person(byId.get(seat.parentUserId.toString())) : null,
      markets,
    };
  }

  private async requireUser(userId: bigint): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }
}

function person(user: User | undefined): PersonView {
  return {
    userId: user?.id ?? 0n,
    nickname: user?.nickname ?? '会员',
    inviteCode: user?.inviteCode ?? null,
    member: user?.member ?? false,
  };
}

function compareJoined(left: InviteTreeNode, right: InviteTreeNode): number {
  const time = left.joinedAt.getTime() - right.joinedAt.getTime();
  if (time !== 0) {
    return time;
  }
  return compareId(left.userId, right.userId);
}

function compareId(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
