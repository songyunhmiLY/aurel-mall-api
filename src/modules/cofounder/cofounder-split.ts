export interface EvenSplit {
  shareFen: bigint;
  distributedFen: bigint;
  retainedFen: bigint;
}

/**
 * 均分向下取整。份额 × 人数不会超过总额，余数留在系统。
 * 人数为 0 时整笔都留在系统，不发给任何人。
 * 余数怎么处理需求没有写明，这是待确认的实现选择。
 */
export function splitEvenly(totalFen: bigint, count: number): EvenSplit {
  if (totalFen <= 0n || count <= 0) {
    return {
      shareFen: 0n,
      distributedFen: 0n,
      retainedFen: totalFen > 0n ? totalFen : 0n,
    };
  }
  const shareFen = totalFen / BigInt(count);
  const distributedFen = shareFen * BigInt(count);
  return { shareFen, distributedFen, retainedFen: totalFen - distributedFen };
}

/** 每人整数份额达到门槛。等价于总额 >= 门槛 × 人数，不会因为余数提前触发。 */
export function perPersonShareReached(
  poolFen: bigint,
  count: number,
  thresholdFen: bigint,
): boolean {
  if (count <= 0 || thresholdFen <= 0n || poolFen <= 0n) {
    return false;
  }
  return poolFen / BigInt(count) >= thresholdFen;
}
