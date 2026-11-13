import { BadRequestException } from '@nestjs/common';

export interface MallRefundAllocation {
  refundFen: number;
  deductionFen: number;
  wechatRefundFen: number;
  withdrawableDeductionFen: number;
  consumptionDeductionFen: number;
  consumptionCreditFen: number;
}

/**
 * 减扣先冲订单的微信部分，再冲该订单的可提现部分，剩余再从退回消费账户的金额里扣。
 * 微信实退 + 消费账户入账 = 退款金额。可提现部分未减扣的余额退回消费账户，不退回可提现账户。
 * 积分不参与会员商城支付；积分不为 0 时拒绝，避免猜积分怎么退。
 */
export function allocateMallRefund(input: {
  payAmountFen: number;
  consumptionFen: number;
  withdrawableFen: number;
  wechatFen: number;
  pointsFen: number;
  deductionFen: number;
}): MallRefundAllocation {
  if (input.pointsFen !== 0) {
    throw new BadRequestException('订单支付构成无法退款');
  }
  const parts = input.consumptionFen + input.withdrawableFen + input.wechatFen;
  if (parts !== input.payAmountFen) {
    throw new BadRequestException('订单支付构成无法退款');
  }
  if (
    !Number.isInteger(input.deductionFen) ||
    input.deductionFen < 0 ||
    input.deductionFen > input.payAmountFen
  ) {
    throw new BadRequestException('减扣金额不正确');
  }

  let remain = input.deductionFen;
  const wechatDeductionFen = Math.min(remain, input.wechatFen);
  remain -= wechatDeductionFen;
  const withdrawableDeductionFen = Math.min(remain, input.withdrawableFen);
  remain -= withdrawableDeductionFen;
  const consumptionDeductionFen = Math.min(remain, input.consumptionFen);
  remain -= consumptionDeductionFen;
  if (remain !== 0) {
    throw new BadRequestException('减扣金额无法分摊');
  }

  const wechatRefundFen = input.wechatFen - wechatDeductionFen;
  const consumptionCreditFen =
    input.consumptionFen -
    consumptionDeductionFen +
    (input.withdrawableFen - withdrawableDeductionFen);
  const refundFen = input.payAmountFen - input.deductionFen;
  if (wechatRefundFen + consumptionCreditFen !== refundFen) {
    throw new BadRequestException('退款金额无法分摊');
  }
  return {
    refundFen,
    deductionFen: input.deductionFen,
    wechatRefundFen,
    withdrawableDeductionFen,
    consumptionDeductionFen,
    consumptionCreditFen,
  };
}

export function resolveRefundAmounts(
  payAmountFen: number,
  input: { refundFen?: number; deductionFen?: number },
): { refundFen: number; deductionFen: number } {
  const hasRefund = input.refundFen !== undefined;
  const hasDeduction = input.deductionFen !== undefined;
  if (hasRefund === hasDeduction) {
    throw new BadRequestException('请只填写退款金额或减扣金额');
  }
  if (hasRefund) {
    const refundFen = input.refundFen ?? 0;
    if (!Number.isInteger(refundFen) || refundFen < 0 || refundFen > payAmountFen) {
      throw new BadRequestException('退款金额不正确');
    }
    return { refundFen, deductionFen: payAmountFen - refundFen };
  }
  const deductionFen = input.deductionFen ?? 0;
  if (!Number.isInteger(deductionFen) || deductionFen < 0 || deductionFen > payAmountFen) {
    throw new BadRequestException('减扣金额不正确');
  }
  return { refundFen: payAmountFen - deductionFen, deductionFen };
}
