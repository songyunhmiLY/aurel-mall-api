const MAX_FEN = 2_147_483_647;

export interface PaymentSplit {
  pointsFen: number;
  withdrawableFen: number;
  consumptionFen: number;
  wechatFen: number;
}

/**
 * 创业专区。积分、可提现都只能出 N 的整数倍，零头留在账户里。
 * 消费账户不参与。账户按 N 对齐后的可用额，再和剩余应付里同样对齐的部分取较小值。
 */
export function splitStartup(
  payableFen: number,
  pointsAvailableFen: bigint,
  withdrawableAvailableFen: bigint,
  unitFen: number,
): PaymentSplit {
  assertPayable(payableFen);
  if (!Number.isInteger(unitFen) || unitFen <= 0 || unitFen > MAX_FEN) {
    throw new Error('创业专区单价无效');
  }
  const pointsFen = takeMultiple(pointsAvailableFen, payableFen, unitFen);
  const withdrawableFen = takeMultiple(withdrawableAvailableFen, payableFen - pointsFen, unitFen);
  return {
    pointsFen,
    withdrawableFen,
    consumptionFen: 0,
    wechatFen: payableFen - pointsFen - withdrawableFen,
  };
}

/**
 * 会员商城。消费账户可以付任意余数，然后可提现账户付任意余数，最后微信支付。
 * 积分账户不参与。
 */
export function splitMall(
  payableFen: number,
  consumptionAvailableFen: bigint,
  withdrawableAvailableFen: bigint,
): PaymentSplit {
  assertPayable(payableFen);
  const consumptionFen = takeUpTo(consumptionAvailableFen, payableFen);
  const withdrawableFen = takeUpTo(withdrawableAvailableFen, payableFen - consumptionFen);
  return {
    pointsFen: 0,
    withdrawableFen,
    consumptionFen,
    wechatFen: payableFen - consumptionFen - withdrawableFen,
  };
}

function takeMultiple(availableFen: bigint, remainingFen: number, unitFen: number): number {
  if (remainingFen <= 0 || availableFen <= 0n) {
    return 0;
  }
  const unit = BigInt(unitFen);
  const alignedAvailable = (availableFen / unit) * unit;
  const alignedRemaining = BigInt(Math.floor(remainingFen / unitFen)) * unit;
  const pay = alignedAvailable < alignedRemaining ? alignedAvailable : alignedRemaining;
  return Number(pay);
}

function takeUpTo(availableFen: bigint, remainingFen: number): number {
  if (remainingFen <= 0 || availableFen <= 0n) {
    return 0;
  }
  const cap = BigInt(remainingFen);
  const pay = availableFen < cap ? availableFen : cap;
  return Number(pay);
}

function assertPayable(payableFen: number): void {
  if (!Number.isInteger(payableFen) || payableFen <= 0 || payableFen > MAX_FEN) {
    throw new Error('订单应付金额无效');
  }
}
