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
