import { BadRequestException } from '@nestjs/common';
import { allocateMallRefund, resolveRefundAmounts } from '../src/modules/orders/refund-split';

const PORTIONS = {
  payAmountFen: 10_000,
  consumptionFen: 4_000,
  withdrawableFen: 3_000,
  wechatFen: 3_000,
  pointsFen: 0,
};

describe('mall refund allocation', () => {
  it('takes the deduction from WeChat, then the withdrawal portion, then consumption credit', () => {
    const heavy = allocateMallRefund({ ...PORTIONS, deductionFen: 4_500 });
    expect(heavy).toMatchObject({
      refundFen: 5_500,
      deductionFen: 4_500,
      wechatRefundFen: 0,
      withdrawableDeductionFen: 1_500,
      consumptionDeductionFen: 0,
      consumptionCreditFen: 5_500,
    });
    expect(heavy.wechatRefundFen + heavy.consumptionCreditFen).toBe(heavy.refundFen);

    const light = allocateMallRefund({ ...PORTIONS, deductionFen: 1_000 });
    expect(light).toMatchObject({
      refundFen: 9_000,
      wechatRefundFen: 2_000,
      withdrawableDeductionFen: 0,
      consumptionCreditFen: 7_000,
    });
    expect(light.wechatRefundFen + light.consumptionCreditFen).toBe(light.refundFen);
  });

  it('computes the missing side and rejects filling both', () => {
    expect(resolveRefundAmounts(10_000, { refundFen: 8_000 })).toEqual({
      refundFen: 8_000,
      deductionFen: 2_000,
    });
    expect(resolveRefundAmounts(10_000, { deductionFen: 2_000 })).toEqual({
      refundFen: 8_000,
      deductionFen: 2_000,
    });
    expect(() => resolveRefundAmounts(10_000, { refundFen: 1, deductionFen: 1 })).toThrow(
      BadRequestException,
    );
    expect(() => resolveRefundAmounts(10_000, {})).toThrow(BadRequestException);
  });

  it('rejects a points portion or a split that does not add up', () => {
    expect(() => allocateMallRefund({ ...PORTIONS, pointsFen: 1, deductionFen: 0 })).toThrow(
      '订单支付构成无法退款',
    );
    expect(() => allocateMallRefund({ ...PORTIONS, payAmountFen: 9_000, deductionFen: 0 })).toThrow(
      '订单支付构成无法退款',
    );
  });
});
