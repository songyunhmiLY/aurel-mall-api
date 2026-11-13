import type { Prisma } from '@prisma/client';

export interface CofounderPaymentEvent {
  paymentId: bigint;
  userId: bigint;
  amountFen: number;
  succeeded: boolean;
  now: Date;
}

/**
 * 微信支付进入终态后的联合创始人开通。
 * 成功才入籍，并写现金流入。失败只把开通单标成失败。
 */
export abstract class CofounderActivationSettler {
  abstract onPaymentFinished(
    tx: Prisma.TransactionClient,
    event: CofounderPaymentEvent,
  ): Promise<void>;
}
