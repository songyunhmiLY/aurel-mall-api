import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { MarketTreeNode, Prisma } from '@prisma/client';

const CHILD_SLOTS = 3;
const MAX_PATH_LENGTH = 2048;

type Tx = Prisma.TransactionClient;

/**
 * 创业专区支付成功后，从已有邀请上级往下找一个空位。
 * 不改邀请上级，也不处理报单和奖励。
 * 对外错误文案不使用“市场树”或“节点”。
 */
@Injectable()
export class TreesService {
  async assertCanSeat(tx: Tx, userId: bigint): Promise<void> {
    const existing = await tx.marketTreeNode.findUnique({ where: { userId } });
    if (existing) {
      return;
    }
    await this.requireInviterSeat(tx, userId);
  }

  /**
   * 已有席位则原样返回，不新增也不搬家。
   * 新席位和用户上的会员标记在同一事务里写入。
   */
  async seat(tx: Tx, userId: bigint, now: Date): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM market_tree_nodes
      WHERE parent_user_id IS NULL
      FOR UPDATE
    `;
    const existing = await tx.marketTreeNode.findUnique({ where: { userId } });
    if (existing) {
      await this.markSeated(tx, userId, now);
      return;
    }
    const inviter = await this.requireInviterSeat(tx, userId);
    const parent = await this.chooseParent(tx, inviter);
    const path = `${parent.path}${userId.toString()}/`;
    if (path.length > MAX_PATH_LENGTH) {
      throw new InternalServerErrorException('入座失败');
    }
    await tx.marketTreeNode.create({
      data: {
        userId,
        parentUserId: parent.userId,
        depth: parent.depth + 1,
        path,
        placedAt: now,
      },
    });
    await this.markSeated(tx, userId, now);
    await this.assertUnderInviter(tx, userId, inviter.userId);
  }

  private async markSeated(tx: Tx, userId: bigint, now: Date): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new InternalServerErrorException('入座失败');
    }
    const inviteCode = user.inviteCode ?? (await allocateInviteCode(tx));
    await tx.user.update({
      where: { id: userId },
      data: { member: true, seated: true, inviteCode, updatedAt: now },
    });
  }

  private async requireInviterSeat(tx: Tx, userId: bigint): Promise<MarketTreeNode> {
    const invite = await tx.inviteTreeNode.findUnique({ where: { userId } });
    if (!invite?.parentUserId) {
      throw new BadRequestException('缺少邀请关系');
    }
    const inviter = await tx.marketTreeNode.findUnique({
      where: { userId: invite.parentUserId },
    });
    if (!inviter) {
      throw new BadRequestException('缺少邀请关系');
    }
    return inviter;
  }

  private async chooseParent(tx: Tx, inviter: MarketTreeNode): Promise<MarketTreeNode> {
    let parents = [inviter];
    const seen = new Set<string>([inviter.userId.toString()]);
    for (let level = 0; level < 10_000; level += 1) {
      const rows = await tx.marketTreeNode.findMany({
        where: { parentUserId: { in: parents.map((node) => node.userId) } },
      });
      const groups = groupChildren(parents, rows);
      let chosen: MarketTreeNode | null = null;
      let chosenEmpty = 0;
      for (let index = 0; index < parents.length; index += 1) {
        const children = groups[index] ?? [];
        const empty = CHILD_SLOTS - children.length;
        if (empty <= 0) {
          continue;
        }
        const parent = parents[index];
        if (!parent) {
          continue;
        }
        if (!chosen || empty > chosenEmpty) {
          chosen = parent;
          chosenEmpty = empty;
        }
      }
      if (chosen) {
        return chosen;
      }
      const next: MarketTreeNode[] = [];
      for (const children of groups) {
        for (const child of children) {
          const key = child.userId.toString();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          next.push(child);
        }
      }
      if (next.length === 0) {
        throw new InternalServerErrorException('入座失败');
      }
      parents = next;
    }
    throw new InternalServerErrorException('入座失败');
  }

  private async assertUnderInviter(tx: Tx, userId: bigint, inviterUserId: bigint): Promise<void> {
    let current = userId;
    const seen = new Set<string>();
    while (current !== inviterUserId) {
      const key = current.toString();
      if (seen.has(key)) {
        throw new InternalServerErrorException('入座失败');
      }
      seen.add(key);
      const node = await tx.marketTreeNode.findUnique({ where: { userId: current } });
      if (!node?.parentUserId) {
        throw new InternalServerErrorException('入座失败');
      }
      current = node.parentUserId;
    }
  }
}

const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function allocateInviteCode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const inviteCode = randomInviteCode();
    const taken = await tx.user.findFirst({ where: { inviteCode } });
    if (!taken) {
      return inviteCode;
    }
  }
  throw new InternalServerErrorException('入座失败');
}

function randomInviteCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) {
    code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length] ?? 'A';
  }
  return code;
}

function groupChildren(parents: MarketTreeNode[], rows: MarketTreeNode[]): MarketTreeNode[][] {
  const buckets = new Map<string, MarketTreeNode[]>();
  for (const row of rows) {
    if (row.parentUserId === null) {
      continue;
    }
    const key = row.parentUserId.toString();
    const list = buckets.get(key);
    if (list) {
      list.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  for (const list of buckets.values()) {
    list.sort(compareSiblings);
  }
  return parents.map((parent) => buckets.get(parent.userId.toString()) ?? []);
}

function compareSiblings(left: MarketTreeNode, right: MarketTreeNode): number {
  const placed = left.placedAt.getTime() - right.placedAt.getTime();
  if (placed !== 0) {
    return placed;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}
