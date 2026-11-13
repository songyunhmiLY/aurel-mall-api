import { BadRequestException } from '@nestjs/common';
import {
  addShanghaiDays,
  isShanghaiBizDate,
  nextBizMonth,
  nextShanghaiDate,
  parseIsoInstant,
  shanghaiAt,
  shanghaiBizDate,
  shanghaiBizMonth,
  startOfBizMonth,
  startOfRecentShanghaiDays,
  startOfShanghaiDay,
} from '../../common/clock/shanghai-calendar';

export const OPS_PERIODS = ['today', 'yesterday', 'last7days', 'month', 'custom'] as const;

export type OpsPeriodKey = (typeof OPS_PERIODS)[number];

const MAX_RANGE_MS = 370 * 24 * 60 * 60 * 1000;

export interface ResolvedOpsPeriod {
  key: OpsPeriodKey;
  from: Date;
  until: Date;
}

export interface OpsPeriodQuery {
  period?: string;
  from?: string;
  to?: string;
}

/** 区间起点所在上海日的前一个完整自然日。 */
export function previousShanghaiDay(from: Date): { bizDate: string; from: Date; until: Date } {
  const until = startOfShanghaiDay(from);
  const start = addShanghaiDays(until, -1);
  return { bizDate: shanghaiBizDate(start), from: start, until };
}

/**
 * 运营总览的统计区间，右端不含。
 * today / yesterday / last7days 都含业务时钟的当天，按上海自然日取整。
 * month 是时钟所在的整个自然月。
 * custom 的 YYYY-MM-DD 含首尾两天；带时区的 ISO 时刻按 [from, to) 使用。
 */
export function resolveOpsPeriod(now: Date, query: OpsPeriodQuery): ResolvedOpsPeriod {
  const key = normalizePeriod(query.period);
  const fromRaw = blankToUndefined(query.from);
  const toRaw = blankToUndefined(query.to);
  if (key !== 'custom') {
    if (fromRaw !== undefined || toRaw !== undefined) {
      throw new BadRequestException('该周期不接受 from 或 to');
    }
    return { key, ...namedRange(key, now) };
  }
  if (fromRaw === undefined || toRaw === undefined) {
    throw new BadRequestException('自定义区间需要 from 和 to');
  }
  const from = parseBound(fromRaw, 'start');
  const until = parseBound(toRaw, 'end');
  if (until.getTime() <= from.getTime()) {
    throw new BadRequestException('结束必须晚于开始');
  }
  if (until.getTime() - from.getTime() > MAX_RANGE_MS) {
    throw new BadRequestException('自定义区间不能超过 370 个自然日');
  }
  return { key, from, until };
}

function namedRange(key: Exclude<OpsPeriodKey, 'custom'>, now: Date): { from: Date; until: Date } {
  const todayStart = startOfShanghaiDay(now);
  const todayEnd = addShanghaiDays(todayStart, 1);
  if (key === 'today') {
    return { from: todayStart, until: todayEnd };
  }
  if (key === 'yesterday') {
    return { from: addShanghaiDays(todayStart, -1), until: todayStart };
  }
  if (key === 'last7days') {
    return { from: startOfRecentShanghaiDays(now, 7), until: todayEnd };
  }
  const month = shanghaiBizMonth(now);
  return { from: startOfBizMonth(month), until: startOfBizMonth(nextBizMonth(month)) };
}

function normalizePeriod(raw: string | undefined): OpsPeriodKey {
  if (raw === undefined || raw.trim() === '') {
    return 'today';
  }
  const value = raw.trim();
  if ((OPS_PERIODS as readonly string[]).includes(value)) {
    return value as OpsPeriodKey;
  }
  throw new BadRequestException('周期不正确');
}

function parseBound(raw: string, edge: 'start' | 'end'): Date {
  const text = raw.trim();
  if (isShanghaiBizDate(text)) {
    return edge === 'start' ? shanghaiAt(text, 0, 0) : shanghaiAt(nextShanghaiDate(text), 0, 0);
  }
  const instant = parseIsoInstant(text);
  if (!instant) {
    throw new BadRequestException('开始和结束不正确');
  }
  return instant;
}

function blankToUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw;
}
