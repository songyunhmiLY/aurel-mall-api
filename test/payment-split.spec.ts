import { splitMall, splitStartup } from '../src/modules/orders/payment-split';

describe('payment split', () => {
  const n = 1000;

  it('keeps a startup remainder smaller than N and skips WeChat when accounts cover the payable', () => {
    expect(splitStartup(3000, 2500n, 1800n, n)).toEqual({
      pointsFen: 2000,
      withdrawableFen: 1000,
      consumptionFen: 0,
      wechatFen: 0,
    });
    expect(splitStartup(1000, 1500n, 0n, n)).toEqual({
      pointsFen: 1000,
      withdrawableFen: 0,
      consumptionFen: 0,
      wechatFen: 0,
    });
    expect(splitStartup(2000, 500n, 2500n, n)).toEqual({
      pointsFen: 0,
      withdrawableFen: 2000,
      consumptionFen: 0,
      wechatFen: 0,
    });
  });

  it('does not let a startup source pay a remainder that is not a multiple of N', () => {
    expect(splitStartup(1250, 5000n, 1800n, n)).toEqual({
      pointsFen: 1000,
      withdrawableFen: 0,
      consumptionFen: 0,
      wechatFen: 250,
    });
    expect(splitStartup(1000, 500n, 0n, n).pointsFen).toBe(0);
    expect(splitStartup(1000, 500n, 0n, n).wechatFen).toBe(1000);
  });

  it('lets mall consumption and withdrawable pay any remainder, and never uses points', () => {
    expect(splitMall(100, 250n, 0n)).toEqual({
      pointsFen: 0,
      withdrawableFen: 0,
      consumptionFen: 100,
      wechatFen: 0,
    });
    expect(splitMall(100, 30n, 80n)).toEqual({
      pointsFen: 0,
      withdrawableFen: 70,
      consumptionFen: 30,
      wechatFen: 0,
    });
    expect(splitMall(100, 10n, 20n)).toEqual({
      pointsFen: 0,
      withdrawableFen: 20,
      consumptionFen: 10,
      wechatFen: 70,
    });
  });
});
