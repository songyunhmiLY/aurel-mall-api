import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CASH_OUTFLOW } from './wallet.constants';

type Tx = Prisma.TransactionClient;

/**
 * 现金流水只追加。运营总览只读这些流出，本服务不提供修改或导出。
 * 微信退款受理、提现打款完成时记一笔流出。商品微信实收不写在这里，
 * 总览按已支付订单的 wechatFen 读取。
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
