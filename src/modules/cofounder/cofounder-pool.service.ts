import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isUniqueConflict, POOL_SLOT, type Tx } from './cofounder.constants';

export interface LockedPool {
  id: bigint;
  balanceFen: bigint;
}

/**
 * 模式 2–4 共用的一个池子。slot 固定为 1。
 * 入籍、取消、计提和发放都先锁这一行，避免和支付回调互相插队。
 */
@Injectable()
export class CofounderPoolService {
  constructor(private readonly prisma: PrismaService) {}

  async lock(tx: Tx, now: Date): Promise<LockedPool> {
    await this.ensure(tx, now);
    await tx.$queryRaw`
      SELECT id FROM cofounder_pools WHERE slot = ${POOL_SLOT} FOR UPDATE
    `;
    const row = await tx.cofounderPool.findUnique({ where: { slot: POOL_SLOT } });
    if (!row) {
      throw new InternalServerErrorException('联合创始人池子不存在');
    }
    return { id: row.id, balanceFen: row.balanceFen };
  }

  async setBalance(tx: Tx, id: bigint, balanceFen: bigint, now: Date): Promise<void> {
    await tx.cofounderPool.update({
      where: { id },
      data: { balanceFen, updatedAt: now },
    });
  }

  async readBalance(): Promise<bigint> {
    const row = await this.prisma.cofounderPool.findUnique({ where: { slot: POOL_SLOT } });
    return row?.balanceFen ?? 0n;
  }

  private async ensure(tx: Tx, now: Date): Promise<void> {
    const existing = await tx.cofounderPool.findUnique({ where: { slot: POOL_SLOT } });
    if (existing) {
      return;
    }
    try {
      await tx.cofounderPool.create({
        data: { slot: POOL_SLOT, balanceFen: 0n, updatedAt: now },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
    }
  }
}
