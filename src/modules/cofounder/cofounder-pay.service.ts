import { ConflictException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PAYMENT_PURPOSE_COFOUNDER } from '../payments/wechat-pay.constants';
import { WechatPayService, type WechatPrepayView } from '../payments/wechat-pay.service';
import { CofounderEnrollmentService } from './cofounder-enrollment.service';
import { CofounderPoolService } from './cofounder-pool.service';

export interface CofounderActivationView extends WechatPrepayView {
  activationId: string;
}

/**
 * 会员用微信支付开通。只复用预下单、回调和沙箱成功，不另开扣款入口。
 * 商户资料已配齐时走正式下单；没配齐时返回沙箱预支付，等沙箱成功接口入账。
 */
@Injectable()
export class CofounderPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly pool: CofounderPoolService,
    private readonly enrollment: CofounderEnrollmentService,
    private readonly wechat: WechatPayService,
  ) {}

  async start(userId: bigint): Promise<CofounderActivationView> {
    const now = await this.clock.now();
    const prepared = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.payment.findFirst({
        where: { userId, purpose: PAYMENT_PURPOSE_COFOUNDER, status: 'pending' },
        orderBy: { id: 'asc' },
      });
      if (pending) {
        await tx.$queryRaw`
          SELECT id FROM payments WHERE pay_no = ${pending.payNo} FOR UPDATE
        `;
      }
      await this.pool.lock(tx, now);
      const amountFen = await this.enrollment.assertPayable(tx, userId);
      const payment = await this.wechat.ensureCofounderPayment(tx, userId, amountFen, now);
      if (payment.amountFen !== amountFen) {
        throw new ConflictException('存在金额不一致的待支付单');
      }
      const activation = await this.enrollment.attachActivation(
        tx,
        userId,
        payment.id,
        amountFen,
        now,
      );
      return { payNo: payment.payNo, activationId: activation.id };
    });
    const view = await this.wechat.presentCofounderPrepay(prepared.payNo, userId);
    return { ...view, activationId: prepared.activationId.toString() };
  }
}
