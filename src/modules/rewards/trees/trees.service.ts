import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { MarketTreeNode, Prisma } from '@prisma/client';
import { isUniqueConflict, uniqueConflictTargets } from '../../../common/prisma/prisma-errors';
import { ROOT_INVITE_CODE } from '../../users/identity.constants';
import {
  MARKET_TREE_MAX_PATH_LENGTH,
  MARKET_TREE_SEAT_ATTEMPTS,
  MARKET_TREE_SLOTS,
} from './market-tree.constants';

type Tx = Prisma.TransactionClient;

/**
 * 创业专区支付成功后，从已有邀请上级往下找一个空位。
 * 不改邀请上级，也不处理报单和奖励。
 * 对外错误文案不使用“市场树”或“节点”。
 *
 * 空位来自 market_tree_open_slots：每个还没满 3 个孩子的节点在那里留一行。
 * 这样找空位是一次带索引的小查询，不必从上级开始逐层 BFS。
 * 「最多 3 个孩子」由 (parent_user_id, slot) 唯一索引兜底，代码不再依赖计数正确。
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
    const existing = await tx.marketTreeNode.findUnique({ where: { userId } });
    if (existing) {
      await this.markSeated(tx, userId, now);
      return;
    }
    const inviter = await this.requireInviterSeat(tx, userId);
    await this.placeUnder(tx, userId, inviter, now);
    await this.assertUnderInviter(tx, userId, inviter.userId);
  }

  /**
   * 抢槽位。按 1、2、3 顺序尝试插入，唯一索引决定谁抢到。
   * 并发时被别的会话抢先占用会命中唯一索引，换下一个槽位即可，不会写出第 4 个孩子。
   */
  private async placeUnder(
    tx: Tx,
    userId: bigint,
    inviter: MarketTreeNode,
    now: Date,
  ): Promise<void> {
    const triedParents = new Set<string>();
    for (let attempt = 0; attempt < MARKET_TREE_SEAT_ATTEMPTS; attempt += 1) {
      const candidate = await this.findOpenSlot(tx, inviter.path, triedParents);
      if (!candidate) {
        throw new InternalServerErrorException('入座失败');
      }
      const parent = await tx.marketTreeNode.findUnique({
        where: { userId: candidate.parentUserId },
      });
      if (!parent) {
        triedParents.add(candidate.parentUserId.toString());
        continue;
      }
      const path = `${parent.path}${userId.toString()}/`;
      if (path.length > MARKET_TREE_MAX_PATH_LENGTH) {
        throw new InternalServerErrorException('入座失败');
      }
      let placed = false;
      for (const slot of MARKET_TREE_SLOTS) {
        try {
          await tx.marketTreeNode.create({
            data: {
              userId,
              parentUserId: parent.userId,
              slot,
              childCount: 0,
              depth: parent.depth + 1,
              path,
              placedAt: now,
            },
          });
        } catch (error) {
          if (!isUniqueConflict(error)) {
            throw error;
          }
          if (isUserSeatConflict(error)) {
            // 同一用户两笔并发支付：另一笔已经把他放进树里了。
            // 这里收敛成「已入座」，不能当成槽位被抢去换下一个槽位。
            await this.markSeated(tx, userId, now);
            return;
          }
          // 槽位被别人抢了，换下一个。
          continue;
        }
        placed = true;
        break;
      }
      if (!placed) {
        triedParents.add(parent.userId.toString());
        continue;
      }
      await this.refreshOpenSlots(tx, parent);
      await tx.marketTreeOpenSlot.createMany({
        data: MARKET_TREE_SLOTS.map((slot) => ({
          parentUserId: userId,
          slot,
          parentDepth: parent.depth + 1,
          parentPath: path,
          openCount: MARKET_TREE_SLOTS.length,
        })),
      });
      await tx.marketTreeNode.update({
        where: { userId: parent.userId },
        data: { childCount: { increment: 1 } },
      });
      await this.markSeated(tx, userId, now);
      return;
    }
    throw new InternalServerErrorException('入座失败');
  }

  /**
   * 按上级子树找最浅的一个还没满的节点。
   * 路径形如 /1/5/9/，所以前缀匹配就能圈出整棵子树。
   * 读到的是事务快照，可能比实际旧，因此调用方会按槽位逐个校验，必要时换下一个上级。
   */
  private findOpenSlot(
    tx: Tx,
    inviterPath: string,
    triedParents: Set<string>,
  ): Promise<{ parentUserId: bigint; slot: number } | null> {
    const excluded = [...triedParents].map((value) => BigInt(value));
    return tx.marketTreeOpenSlot.findFirst({
      where: {
        parentPath: { startsWith: inviterPath },
        ...(excluded.length > 0 ? { parentUserId: { notIn: excluded } } : {}),
      },
      orderBy: [
        { parentDepth: 'asc' },
        { openCount: 'desc' },
        { parentPath: 'asc' },
        { slot: 'asc' },
      ],
      select: { parentUserId: true, slot: true },
    });
  }

  /** 重建某个上级的空闲槽位行，让它们和实际占用对上。 */
  private async refreshOpenSlots(tx: Tx, parent: MarketTreeNode): Promise<void> {
    const children = await tx.marketTreeNode.findMany({
      where: { parentUserId: parent.userId },
      select: { slot: true },
    });
    const used = new Set(children.map((child) => child.slot));
    await tx.marketTreeOpenSlot.deleteMany({ where: { parentUserId: parent.userId } });
    const free = MARKET_TREE_SLOTS.filter((slot) => !used.has(slot));
    if (free.length === 0) {
      return;
    }
    await tx.marketTreeOpenSlot.createMany({
      data: free.map((slot) => ({
        parentUserId: parent.userId,
        slot,
        parentDepth: parent.depth,
        parentPath: parent.path,
        openCount: free.length,
      })),
    });
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

  /** 后置校验：新节点的路径必须以邀请上级的路径开头。原来逐级上溯，每级一次查询。 */
  private async assertUnderInviter(tx: Tx, userId: bigint, inviterUserId: bigint): Promise<void> {
    const node = await tx.marketTreeNode.findUnique({ where: { userId } });
    const inviter = await tx.marketTreeNode.findUnique({ where: { userId: inviterUserId } });
    if (!node || !inviter || !node.path.startsWith(inviter.path)) {
      throw new InternalServerErrorException('入座失败');
    }
  }

  /**
   * 从现有树重建空闲槽位表。只在数据被外部改过、槽位表对不上时手工执行。
   * 不是入座热路径的一部分。
   */
  async rebuildOpenSlots(tx: Tx): Promise<number> {
    await tx.marketTreeOpenSlot.deleteMany({});
    return tx.$executeRaw`
      INSERT INTO market_tree_open_slots
        (parent_user_id, slot, parent_depth, parent_path, open_count)
      SELECT node.user_id, position.slot, node.depth, node.path, 3 - node.child_count
      FROM market_tree_nodes AS node
      JOIN (SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3) AS position
        ON position.slot > node.child_count
    `;
  }
}

/**
 * 唯一冲突是不是「这个用户已经有席位」。
 *
 * userId 唯一索引和 (parent_user_id, slot) 唯一索引都会抛 P2002，必须分开看：
 * 前者说明已经入过座（并发支付、或重复支付），后者才是槽位被抢。
 * 读不到索引名时返回 false，退化成「槽位被抢」去重试，不会误判成已入座。
 */
export function isUserSeatConflict(error: unknown): boolean {
  return uniqueConflictTargets(error).some(
    (target) => target === 'market_tree_user_id_uq' || target === 'user_id',
  );
}

async function allocateInviteCode(tx: Tx): Promise<string> {  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inviteCode = randomSixDigitCode();
    if (inviteCode === ROOT_INVITE_CODE) {
      continue;
    }
    const taken = await tx.user.findFirst({ where: { inviteCode } });
    if (!taken) {
      return inviteCode;
    }
  }
  throw new InternalServerErrorException('入座失败');
}

function randomSixDigitCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}
