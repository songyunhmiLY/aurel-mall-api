import type { WalletSplit } from '../src/config/locked-runtime';
import { applyBps, splitAwardFen } from '../src/modules/rewards/award-split';

const startup: WalletSplit = { withdrawableBps: 8500, pointsBps: 500, consumptionBps: 1000 };
const mall: WalletSplit = { withdrawableBps: 8500, pointsBps: 1000, consumptionBps: 500 };

describe('award integer split', () => {
  it('splits exact ratios and gives the remainder to the largest share', () => {
    expect(splitAwardFen(10_000n, startup)).toEqual({
      withdrawableFen: 8500n,
      pointsFen: 500n,
      consumptionFen: 1000n,
    });
    expect(splitAwardFen(10_000n, mall)).toEqual({
      withdrawableFen: 8500n,
      pointsFen: 1000n,
      consumptionFen: 500n,
    });
    expect(splitAwardFen(1n, startup)).toEqual({
      withdrawableFen: 1n,
      pointsFen: 0n,
      consumptionFen: 0n,
    });
    const parts = splitAwardFen(5005n, startup);
    expect(parts.withdrawableFen + parts.pointsFen + parts.consumptionFen).toBe(5005n);
    expect(parts).toEqual({ withdrawableFen: 4255n, pointsFen: 250n, consumptionFen: 500n });
  });

  it('floors a ratio and returns zero for a non-positive base', () => {
    expect(applyBps(100_000n, 2000)).toBe(20_000n);
    expect(applyBps(101n, 3333)).toBe(33n);
    expect(applyBps(0n, 500)).toBe(0n);
    expect(applyBps(100n, 0)).toBe(0n);
  });
});
