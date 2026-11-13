import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { WalletSplit } from '../../config/locked-runtime';
import {
  LEDGER_CREDIT,
  WALLET_CONSUMPTION,
  WALLET_POINTS,
  WALLET_WITHDRAWABLE,
  type WalletType,
} from '../wallet/wallet.constants';
import { WalletService } from '../wallet/wallet.service';
import { splitAwardFen } from './award-split';

type Tx = Prisma.TransactionClient;

export interface AwardPart {
  walletType: WalletType;
  amountFen: bigint;
  sourceCode: string | null;
}

/**
 * 奖励入账。同一用户、账户、方向、业务类型和业务号只记一次。
 * 可提现账户才写 sourceCode；积分和消费账户的来源留在 bizType。
 */
@Injectable()
export class AwardCreditService {
  constructor(private readonly wallet: WalletService) {}

  async creditSplit(
    tx: Tx,
    input: {
      userId: bigint;
      amountFen: bigint;
      split: WalletSplit;
      bizType: string;
      bizId: string;
      sourceCode: string;
      orderId?: bigint | null;
      layer?: number | null;
      now: Date;
    },
  ): Promise<void> {
    if (input.amountFen <= 0n) {
      return;
    }
    const parts = splitAwardFen(input.amountFen, input.split);
    await this.creditParts(tx, {
      userId: input.userId,
      bizType: input.bizType,
      bizId: input.bizId,
      rewardType: input.bizType,
      rewardFen: input.amountFen,
      orderId: input.orderId ?? null,
      layer: input.layer ?? null,
      now: input.now,
      parts: [
        {
          walletType: WALLET_WITHDRAWABLE,
          amountFen: parts.withdrawableFen,
          sourceCode: input.sourceCode,
        },
        { walletType: WALLET_POINTS, amountFen: parts.pointsFen, sourceCode: null },
        { walletType: WALLET_CONSUMPTION, amountFen: parts.consumptionFen, sourceCode: null },
      ],
    });
  }

  async creditParts(
    tx: Tx,
    input: {
      userId: bigint;
      parts: AwardPart[];
      bizType: string;
      bizId: string;
      rewardType: string;
      rewardFen: bigint;
      orderId?: bigint | null;
      layer?: number | null;
      now: Date;
    },
  ): Promise<void> {
    const payable = input.parts.filter((part) => part.amountFen > 0n);
    if (payable.length === 0) {
      return;
    }
    await this.wallet.lockAll(tx, input.userId, input.now);
    for (const part of payable) {
      await this.creditOne(tx, input.userId, input.bizType, input.bizId, part, input.now);
    }
    if (input.rewardFen > 0n) {
      await this.writeReward(tx, input);
    }
  }

  private async creditOne(
    tx: Tx,
    userId: bigint,
    bizType: string,
    bizId: string,
    part: AwardPart,
    now: Date,
  ): Promise<void> {
    const existing = await tx.walletLedgerEntry.findFirst({
      where: {
        userId,
        walletType: part.walletType,
        direction: LEDGER_CREDIT,
        bizType,
        bizId,
      },
    });
    if (existing) {
      return;
    }
    await this.wallet.creditInTx(
      tx,
      {
        userId,
        walletType: part.walletType,
        amountFen: part.amountFen,
        bizType,
        bizId,
        sourceCode: part.sourceCode,
      },
      now,
    );
  }

  private async writeReward(
    tx: Tx,
    input: {
      userId: bigint;
      bizType: string;
      bizId: string;
      rewardType: string;
      rewardFen: bigint;
      orderId?: bigint | null;
      layer?: number | null;
      now: Date;
    },
  ): Promise<void> {
    const existing = await tx.rewardLedgerEntry.findFirst({
      where: {
        userId: input.userId,
        rewardType: input.rewardType,
        bizType: input.bizType,
        bizId: input.bizId,
      },
    });
    if (existing) {
      return;
    }
    await tx.rewardLedgerEntry.create({
      data: {
        userId: input.userId,
        rewardType: input.rewardType,
        amountFen: input.rewardFen,
        status: 'posted',
        bizType: input.bizType,
        bizId: input.bizId,
        orderId: input.orderId ?? null,
        layer: input.layer ?? null,
        occurredAt: input.now,
        createdAt: input.now,
      },
    });
  }
}
