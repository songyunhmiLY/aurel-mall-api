import type { WalletSplit } from '../../config/locked-runtime';

export interface FenSplit {
  withdrawableFen: bigint;
  pointsFen: bigint;
  consumptionFen: bigint;
}

/** 万分比向下取整。金额和比例都按整数算，不用浮点。 */
export function applyBps(amountFen: bigint, bps: number): bigint {
  if (amountFen <= 0n || bps <= 0) {
    return 0n;
  }
  return (amountFen * BigInt(bps)) / 10_000n;
}

/**
 * 把一笔奖励拆进三个账户。三项向下取整后的余数加给比例最大的账户；
 * 比例相同则优先可提现，其次积分，最后消费。拆分之后三项之和等于原金额。
 */
export function splitAwardFen(amountFen: bigint, split: WalletSplit): FenSplit {
  if (amountFen <= 0n) {
    return { withdrawableFen: 0n, pointsFen: 0n, consumptionFen: 0n };
  }
  const result: FenSplit = {
    withdrawableFen: applyBps(amountFen, split.withdrawableBps),
    pointsFen: applyBps(amountFen, split.pointsBps),
    consumptionFen: applyBps(amountFen, split.consumptionBps),
  };
  const remainder = amountFen - result.withdrawableFen - result.pointsFen - result.consumptionFen;
  if (remainder > 0n) {
    const ranked: Array<{ key: keyof FenSplit; bps: number }> = [
      { key: 'withdrawableFen', bps: split.withdrawableBps },
      { key: 'pointsFen', bps: split.pointsBps },
      { key: 'consumptionFen', bps: split.consumptionBps },
    ];
    const target = ranked.reduce((best, item) => (item.bps > best.bps ? item : best));
    result[target.key] += remainder;
  }
  return result;
}
