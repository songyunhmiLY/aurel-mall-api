export const BUSINESS_TIMEZONE = 'Asia/Shanghai';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

interface ShanghaiWallClock {
  year: number;
  monthIndex: number;
  day: number;
}

function shanghaiWallClock(instant: Date): ShanghaiWallClock {
  const shifted = new Date(instant.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function fromShanghaiWall(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day) - SHANGHAI_OFFSET_MS);
}

export function startOfShanghaiDay(instant: Date): Date {
  const wall = shanghaiWallClock(instant);
  return fromShanghaiWall(wall.year, wall.monthIndex, wall.day);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfNextShanghaiDay(instant: Date): Date {
  return new Date(startOfShanghaiDay(instant).getTime() + DAY_MS);
}

export function addShanghaiDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/** 区间 [from, until) 碰到的每个上海自然日，按时间升序。 */
export function shanghaiDaysOverlapping(from: Date, until: Date): string[] {
  if (until.getTime() <= from.getTime()) {
    return [];
  }
  const days: string[] = [];
  let cursor = startOfShanghaiDay(from);
  while (cursor.getTime() < until.getTime()) {
    days.push(shanghaiBizDate(cursor));
    cursor = addShanghaiDays(cursor, 1);
    if (days.length > 400) {
      throw new Error('区间过长');
    }
  }
  return days;
}

/** until 之前那一毫秒所在的上海自然日。until 落在 00:00 时就是前一天。 */
export function shanghaiBizDateBefore(until: Date): string {
  return shanghaiBizDate(new Date(until.getTime() - 1));
}

/**
 * 带时区的 ISO 时刻。不接受没有时区的时间，避免把机器本地时区当成上海。
 * 日期请走 YYYY-MM-DD，不要走这里。
 */
export function parseIsoInstant(value: string): Date | null {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return null;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function startOfShanghaiMonth(instant: Date): Date {
  const wall = shanghaiWallClock(instant);
  return fromShanghaiWall(wall.year, wall.monthIndex, 1);
}

export function shanghaiBizDate(instant: Date): string {
  const wall = shanghaiWallClock(instant);
  const month = String(wall.monthIndex + 1).padStart(2, '0');
  const day = String(wall.day).padStart(2, '0');
  return `${wall.year}-${month}-${day}`;
}

export function shanghaiBizMonth(instant: Date): string {
  const wall = shanghaiWallClock(instant);
  const month = String(wall.monthIndex + 1).padStart(2, '0');
  return `${wall.year}-${month}`;
}

/** 上海日历日的 00:00 再加上 hour:minute。hour、minute 由调用方保证在范围内。 */
export function shanghaiAt(bizDate: string, hour: number, minute: number): Date {
  const parts = parseBizDate(bizDate);
  return new Date(
    Date.UTC(parts.year, parts.monthIndex, parts.day, hour, minute) - SHANGHAI_OFFSET_MS,
  );
}

export function startOfBizMonth(month: string): Date {
  const parts = parseBizMonth(month);
  return fromShanghaiWall(parts.year, parts.monthIndex, 1);
}

export function nextBizMonth(month: string): string {
  const parts = parseBizMonth(month);
  return shanghaiBizMonth(fromShanghaiWall(parts.year, parts.monthIndex + 1, 1));
}

export function previousBizMonth(month: string): string {
  const parts = parseBizMonth(month);
  return shanghaiBizMonth(fromShanghaiWall(parts.year, parts.monthIndex - 1, 1));
}

export function nextShanghaiDate(bizDate: string): string {
  const start = shanghaiAt(bizDate, 0, 0);
  return shanghaiBizDate(new Date(start.getTime() + 24 * 60 * 60 * 1000));
}

/** 含当天在内、向前共 days 个上海自然日的起点。days = 7 时是今天和前 6 天。 */
export function startOfRecentShanghaiDays(instant: Date, days: number): Date {
  const start = startOfShanghaiDay(instant);
  return new Date(start.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
}

export function isShanghaiBizDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return shanghaiBizDate(shanghaiAt(value, 0, 0)) === value;
}

export function isShanghaiBizMonth(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return false;
  }
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

function parseBizDate(bizDate: string): ShanghaiWallClock {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bizDate);
  if (!match) {
    throw new Error('业务日不正确');
  }
  return {
    year: Number(match[1]),
    monthIndex: Number(match[2]) - 1,
    day: Number(match[3]),
  };
}

function parseBizMonth(month: string): { year: number; monthIndex: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    throw new Error('业务月不正确');
  }
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}
