import {
  shanghaiBizDate,
  startOfShanghaiDay,
  startOfShanghaiMonth,
} from '../src/common/clock/shanghai-calendar';

describe('Asia/Shanghai calendar', () => {
  it('uses the Shanghai day that starts at 16:00 UTC', () => {
    const lateEvening = new Date('2026-11-12T15:30:00.000Z');
    expect(startOfShanghaiDay(lateEvening).toISOString()).toBe('2026-11-11T16:00:00.000Z');
    expect(shanghaiBizDate(lateEvening)).toBe('2026-11-12');

    const justAfterMidnight = new Date('2026-11-12T16:30:00.000Z');
    expect(startOfShanghaiDay(justAfterMidnight).toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(shanghaiBizDate(justAfterMidnight)).toBe('2026-11-13');
  });

  it('starts the month on the Shanghai first day', () => {
    const instant = new Date('2026-11-12T16:30:00.000Z');
    expect(startOfShanghaiMonth(instant).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(startOfShanghaiMonth(new Date('2026-03-01T00:00:00+08:00')).toISOString()).toBe(
      '2026-02-28T16:00:00.000Z',
    );
  });
});
