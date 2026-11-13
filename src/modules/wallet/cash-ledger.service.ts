import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CASH_INFLOW, CASH_OUTFLOW } from './wallet.constants';

type Tx = Prisma.TransactionClient;

/**
 * 现金流水只追加。本服务不提供修改或导出。
 * 微信退款受理、提现打款完成时记一笔流出。
 * 联合创始人开通的微信收款记一笔流入，不并进商品订单的 wechatFen。
 * 商品微信实收仍不写在这里，总览按已支付订单的 wechatFen 读取。
 */
@Injectable()
export class CashLedgerService {
  async recordOutflow(
    tx: Tx,
    input: { amountFen: bigint; bizType: string; bizId: string; occurredAt: Date },
  ): Promise<void> {
    await this.record(tx, CASH_OUTFLOW, input);
  }

  async recordInflow(
    tx: Tx,
    input: { amountFen: bigint; bizType: string; bizId: string; occurredAt: Date },
  ): Promise<void> {
    await this.record(tx, CASH_INFLOW, input);
  }

  private async record(
    tx: Tx,
    direction: string,
    input: { amountFen: bigint; bizType: string; bizId: string; occurredAt: Date },
  ): Promise<void> {
    if (input.amountFen <= 0n) {
      return;
    }
    const existing = await tx.cashLedgerEntry.findFirst({
      where: { direction, bizType: input.bizType, bizId: input.bizId },
    });
    if (existing) {
      return;
    }
    await tx.cashLedgerEntry.create({
      data: {
        direction,
        amountFen: input.amountFen,
        bizType: input.bizType,
        bizId: input.bizId,
        occurredAt: input.occurredAt,
        createdAt: input.occurredAt,
      },
    });
  }
}
