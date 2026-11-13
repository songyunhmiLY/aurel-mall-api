import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { USER_STATUS_ACTIVE } from '../../common/auth/user-status';
import { PaymentPasswordService } from './payment-password.service';
import { LEDGER_CONSUMPTION_TRANSFER, WALLET_CONSUMPTION } from './wallet.constants';
import { WalletService } from './wallet.service';

const MAX_AMOUNT = 9223372036854775807n;

export interface TransferLookupView {
  payeeId: bigint;
  nickname: string;
}

export interface TransferView {
  id: bigint;
  payeeId: bigint;
  amountFen: bigint;
  createdAt: string;
}

/**
 * 会员之间划转消费账户可用余额。不收手续费，不检查实名。
 * 积分和可提现账户不能走这里。本人三个账户之间也不能互转。
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly wallet: WalletService,
    private readonly passwords: PaymentPasswordService,
  ) {}

  async lookup(payerUserId: bigint, payeeUserId: bigint): Promise<TransferLookupView> {
    await this.requireMember(payerUserId, '非会员不能划转');
    if (payerUserId === payeeUserId) {
      throw new BadRequestException('不能转给自己');
    }
    const payee = await this.requireMember(payeeUserId, '对方不是会员');
    return { payeeId: payee.id, nickname: payee.nickname };
  }

  async transfer(
    payerUserId: bigint,
    input: { payeeUserId: bigint; amountFen: bigint; paymentPassword: string },
  ): Promise<TransferView> {
    if (input.amountFen <= 0n || input.amountFen > MAX_AMOUNT) {
      throw new BadRequestException('金额不正确');
    }
    const lookedUp = await this.lookup(payerUserId, input.payeeUserId);
    await this.passwords.assertMatches(payerUserId, input.paymentPassword);
    const now = await this.clock.now();
    const created = await this.prisma.$transaction(async (tx) => {
      const [first, second] = lockOrder(payerUserId, lookedUp.payeeId);
      await this.wallet.lockAll(tx, first, now);
      await this.wallet.lockAll(tx, second, now);
      const row = await tx.consumptionTransfer.create({
        data: {
          payerUserId,
          payeeUserId: lookedUp.payeeId,
          amountFen: input.amountFen,
          createdAt: now,
        },
      });
      const bizId = row.id.toString();
      await this.wallet.debitAvailable(
        tx,
        payerUserId,
        WALLET_CONSUMPTION,
        input.amountFen,
        LEDGER_CONSUMPTION_TRANSFER,
        bizId,
        now,
      );
      await this.wallet.creditInTx(
        tx,
        {
          userId: lookedUp.payeeId,
          walletType: WALLET_CONSUMPTION,
          amountFen: input.amountFen,
          bizType: LEDGER_CONSUMPTION_TRANSFER,
          bizId,
          sourceCode: null,
        },
        now,
      );
      return row;
    });
    return {
      id: created.id,
      payeeId: created.payeeUserId,
      amountFen: created.amountFen,
      createdAt: created.createdAt.toISOString(),
    };
  }

  private async requireMember(userId: bigint, message: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== USER_STATUS_ACTIVE || !user.member) {
      if (message === '非会员不能划转') {
        throw new ForbiddenException(message);
      }
      throw new BadRequestException(message);
    }
    return user;
  }
}

function lockOrder(left: bigint, right: bigint): [bigint, bigint] {
  return left < right ? [left, right] : [right, left];
}
