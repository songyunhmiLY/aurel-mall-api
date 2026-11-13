import { applyBps } from '../award-split';

export interface WelfareQuota {
  openedRoundCount: bigint;
  claimCapFen: bigint;
  currentRoundNo: bigint;
  /** 正在被已领金额占用的那一轮里已经计入的金额。正好领满时算在刚领满的那一轮。 */
  currentRoundClaimedFen: bigint;
  /** 累计已领 < 当前上限。不含会员身份。 */
  moneyEligible: boolean;
}

export interface PoolSplit {
  poolFen: bigint;
  shareFen: bigint;
  distributedFen: bigint;
  remainderFen: bigint;
}

/**
 * 已开轮数 = floor(累计微信支付实付 / K)。
 * K 为 0 时无法整除，按不开轮处理。这是实现选择，正式规则未写 K = 0。
 */
export function openedRoundCount(actualPayFen: bigint, thresholdFen: number): bigint {
  if (thresholdFen <= 0 || actualPayFen <= 0n) {
    return 0n;
  }
  return actualPayFen / BigInt(thresholdFen);
}

export function describeWelfareQuota(
  actualPayFen: bigint,
  claimedFen: bigint,
  thresholdFen: number,
  capPerRoundFen: number,
): WelfareQuota {
  const opened = openedRoundCount(actualPayFen, thresholdFen);
  const capPerRound = BigInt(capPerRoundFen < 0 ? 0 : capPerRoundFen);
  const claimCapFen = opened * capPerRound;
  const claimed = claimedFen < 0n ? 0n : claimedFen;
  let currentRoundNo = 0n;
  let currentRoundClaimedFen = 0n;
  if (claimed === 0n) {
    currentRoundNo = opened > 0n ? 1n : 0n;
  } else if (capPerRound === 0n) {
    currentRoundNo = opened;
    currentRoundClaimedFen = claimed;
  } else {
    currentRoundNo = (claimed - 1n) / capPerRound + 1n;
    currentRoundClaimedFen = claimed - (currentRoundNo - 1n) * capPerRound;
  }
  return {
    openedRoundCount: opened,
    claimCapFen,
    currentRoundNo,
    currentRoundClaimedFen,
    moneyEligible: claimed < claimCapFen,
  };
}

/**
 * 奖池和每人份额都向下取整。份额 × 人数不会超过奖池。
 * 余数不发给任何人，留在系统。人数为 0 时整池都是余数。
 */
export function splitPool(salesFen: bigint, accrualBps: number, signupCount: number): PoolSplit {
  const poolFen = applyBps(salesFen, accrualBps);
  if (signupCount <= 0) {
    return { poolFen, shareFen: 0n, distributedFen: 0n, remainderFen: poolFen };
  }
  const shareFen = poolFen / BigInt(signupCount);
  const distributedFen = shareFen * BigInt(signupCount);
  return {
    poolFen,
    shareFen,
    distributedFen,
    remainderFen: poolFen - distributedFen,
  };
}
