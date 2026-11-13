import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CASH_OUTFLOW } from './wallet.constants';

type Tx = Prisma.TransactionClient;

/**
 * 现金流水只追加。本阶段不提供总览和导出接口。
 * 微信退款受理、提现打款完成时记一笔流出。
 */
@Injectable()
export class CashLedgerService {
  async recordOutflow(
    tx: Tx,
    input: { amountFen: bigint; bizType: string; bizId: string; occurredAt: Date },
  ): Promise<void> {
    if (input.amountFen <= 0n) {
      return;
    }
    await tx.cashLedgerEntry.create({
      data: {
        direction: CASH_OUTFLOW,
        amountFen: input.amountFen,
        bizType: input.bizType,
        bizId: input.bizId,
        occurredAt: input.occurredAt,
        createdAt: input.occurredAt,
      },
    });
  }
}
