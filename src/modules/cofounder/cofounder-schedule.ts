import {
  addShanghaiBizDays,
  daysInShanghaiMonth,
  diffShanghaiDays,
  isShanghaiBizDate,
  previousBizMonth,
  shanghaiAt,
  shanghaiBizDate,
  shanghaiBizMonth,
  shanghaiWeekday,
} from '../../common/clock/shanghai-calendar';
import {
  SCHEDULE_CYCLES,
  SCHEDULE_DAILY,
  SCHEDULE_INTERVAL,
  SCHEDULE_MONTHLY,
  SCHEDULE_WEEKLY,
  type CofounderSchedule,
  type ScheduleCycle,
} from './cofounder.constants';

export interface DueSlot {
  key: string;
  firesAt: Date;
}

interface ClockTime {
  hour: number;
  minute: number;
}

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function sameSchedule(left: CofounderSchedule, right: CofounderSchedule): boolean {
  return (
    left.cycle === right.cycle &&
    left.time === right.time &&
    left.weekday === right.weekday &&
    left.monthDay === right.monthDay &&
    left.intervalDays === right.intervalDays &&
    left.anchorDate === right.anchorDate
  );
}

/**
 * 不晚于 now 的最近一个发放档期。
 * 日、周、月总能找到已经过去的一档。间隔周期在锚点时刻之前没有档期。
 * 月档若设了 29–31 日而该月没有这一天，落在该月最后一天。这是待确认的实现选择。
 */
export function latestDueSlot(now: Date, schedule: CofounderSchedule): DueSlot | null {
  const time = parseClock(schedule.time);
  if (!time) {
    return null;
  }
  if (schedule.cycle === SCHEDULE_DAILY) {
    return dailySlot(now, time);
  }
  if (schedule.cycle === SCHEDULE_WEEKLY) {
    return weeklySlot(now, schedule.weekday, time);
  }
  if (schedule.cycle === SCHEDULE_MONTHLY) {
    return monthlySlot(now, schedule.monthDay, time);
  }
  if (schedule.cycle === SCHEDULE_INTERVAL) {
    return intervalSlot(now, schedule, time);
  }
  return null;
}

export function isScheduleCycle(value: string): value is ScheduleCycle {
  return (SCHEDULE_CYCLES as readonly string[]).includes(value);
}

function dailySlot(now: Date, time: ClockTime): DueSlot {
  const today = shanghaiBizDate(now);
  const todayFire = shanghaiAt(today, time.hour, time.minute);
  const bizDate = todayFire.getTime() <= now.getTime() ? today : addShanghaiBizDays(today, -1);
  return slot(`daily:${bizDate}`, bizDate, time);
}

function weeklySlot(now: Date, weekday: number, time: ClockTime): DueSlot {
  const today = shanghaiBizDate(now);
  const delta = (shanghaiWeekday(now) - weekday + 7) % 7;
  let bizDate = addShanghaiBizDays(today, -delta);
  let fire = shanghaiAt(bizDate, time.hour, time.minute);
  if (fire.getTime() > now.getTime()) {
    bizDate = addShanghaiBizDays(bizDate, -7);
    fire = shanghaiAt(bizDate, time.hour, time.minute);
  }
  return { key: `weekly:${bizDate}`, firesAt: fire };
}

function monthlySlot(now: Date, monthDay: number, time: ClockTime): DueSlot {
  let month = shanghaiBizMonth(now);
  let picked = monthFire(month, monthDay, time);
  if (picked.firesAt.getTime() > now.getTime()) {
    month = previousBizMonth(month);
    picked = monthFire(month, monthDay, time);
  }
  return picked;
}

function monthFire(month: string, monthDay: number, time: ClockTime): DueSlot {
  const last = daysInShanghaiMonth(month);
  const day = Math.min(Math.max(monthDay, 1), last);
  const bizDate = `${month}-${String(day).padStart(2, '0')}`;
  return slot(`monthly:${bizDate}`, bizDate, time);
}

function intervalSlot(now: Date, schedule: CofounderSchedule, time: ClockTime): DueSlot | null {
  if (!isShanghaiBizDate(schedule.anchorDate) || schedule.intervalDays < 1) {
    return null;
  }
  const first = shanghaiAt(schedule.anchorDate, time.hour, time.minute);
  if (now.getTime() < first.getTime()) {
    return null;
  }
  const anchorStart = shanghaiAt(schedule.anchorDate, 0, 0);
  let steps = Math.floor(diffShanghaiDays(now, anchorStart) / schedule.intervalDays);
  if (steps < 0) {
    return null;
  }
  let bizDate = addShanghaiBizDays(schedule.anchorDate, steps * schedule.intervalDays);
  let fire = shanghaiAt(bizDate, time.hour, time.minute);
  if (fire.getTime() > now.getTime()) {
    steps -= 1;
    if (steps < 0) {
      return null;
    }
    bizDate = addShanghaiBizDays(schedule.anchorDate, steps * schedule.intervalDays);
    fire = shanghaiAt(bizDate, time.hour, time.minute);
  }
  return { key: `interval:${bizDate}`, firesAt: fire };
}

function slot(key: string, bizDate: string, time: ClockTime): DueSlot {
  return { key, firesAt: shanghaiAt(bizDate, time.hour, time.minute) };
}

function parseClock(value: string): ClockTime | null {
  const match = CLOCK_TIME.exec(value);
  if (!match) {
    return null;
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
