import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isMessageCategory, type MessageCategory } from './message.constants';

type Tx = Prisma.TransactionClient;

export interface MessageView {
  id: string;
  category: string;
  title: string;
  body: string;
  linkPage: string | null;
  read: boolean;
  createdAt: string;
}

export interface MessagePage {
  items: MessageView[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
}

export interface MessageDraft {
  userId: bigint;
  category: MessageCategory;
  title: string;
  body: string;
  linkPage?: string | null;
  bizType?: string | null;
  bizId?: string | null;
}

/**
 * 站内系统消息。业务事件在同一个事务里调用 record 写入，事务回滚时消息也不留下。
 * 未读口径只有一个：消息时间晚于用户上次查看时间。打开列表即视为全部已读。
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async record(tx: Tx, draft: MessageDraft, now: Date): Promise<void> {
    await tx.userMessage.create({
      data: {
        userId: draft.userId,
        category: draft.category,
        title: draft.title.slice(0, 64),
        body: draft.body.slice(0, 500),
        linkPage: draft.linkPage ?? null,
        bizType: draft.bizType ?? null,
        bizId: draft.bizId ?? null,
        createdAt: now,
      },
    });
  }

  async listForUser(
    userId: bigint,
    query: { category?: string; page: number; pageSize: number },
  ): Promise<MessagePage> {
    const where: Prisma.UserMessageWhereInput = { userId };
    if (query.category !== undefined && isMessageCategory(query.category)) {
      where.category = query.category;
    }
    const [rows, total, readAt] = await Promise.all([
      this.prisma.userMessage.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.userMessage.count({ where }),
      this.messagesReadAt(userId),
    ]);
    const unreadWhere = unreadFilter(userId, readAt);
    const unreadCount = await this.prisma.userMessage.count({ where: unreadWhere });
    return {
      items: rows.map((row) => toView(row, readAt)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      unreadCount,
    };
  }

  async unreadCount(userId: bigint): Promise<{ unreadCount: number }> {
    const readAt = await this.messagesReadAt(userId);
    const unreadCount = await this.prisma.userMessage.count({
      where: unreadFilter(userId, readAt),
    });
    return { unreadCount };
  }

  async markRead(userId: bigint): Promise<{ readAt: string; unreadCount: number }> {
    const now = await this.clock.now();
    await this.prisma.user.update({ where: { id: userId }, data: { messagesReadAt: now } });
    return { readAt: now.toISOString(), unreadCount: 0 };
  }

  async getForUser(userId: bigint, id: bigint): Promise<MessageView> {
    const row = await this.prisma.userMessage.findFirst({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException('消息不存在');
    }
    return toView(row, await this.messagesReadAt(userId));
  }

  private async messagesReadAt(userId: bigint): Promise<Date | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { messagesReadAt: true },
    });
    return user?.messagesReadAt ?? null;
  }
}

function unreadFilter(userId: bigint, readAt: Date | null): Prisma.UserMessageWhereInput {
  return readAt === null ? { userId } : { userId, createdAt: { gt: readAt } };
}

function toView(
  row: {
    id: bigint;
    category: string;
    title: string;
    body: string;
    linkPage: string | null;
    createdAt: Date;
  },
  readAt: Date | null,
): MessageView {
  return {
    id: row.id.toString(),
    category: row.category,
    title: row.title,
    body: row.body,
    linkPage: row.linkPage,
    read: readAt !== null && row.createdAt.getTime() <= readAt.getTime(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** 订单类消息的入口页面，与管理端订单详情保持一致。 */
export function orderMessageLink(orderId: bigint): string {
  return `/pages/order/detail?id=${orderId.toString()}`;
}

export const MESSAGE_OF = {
  orderPaid: 'order',
  orderShipped: 'order',
  orderClosed: 'order',
  withdrawal: 'wallet',
  luckyReturn: 'wallet',
} as const;

/** 金额展示：分转元，两位小数。消息正文统一用它，避免各处格式不一致。 */
export function yuanText(fen: bigint | number): string {
  return `¥${(Number(fen) / 100).toFixed(2)}`;
}
