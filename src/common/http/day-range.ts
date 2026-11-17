import { BadRequestException } from '@nestjs/common';
import { addShanghaiDays, isShanghaiBizDate, shanghaiAt } from '../clock/shanghai-calendar';

/**
 * 把 YYYY-MM-DD 的 from/to 查询参数解析成上海自然日边界 [from, until)。
 * from 是开始日 00:00；to 是结束日，until 取结束日次日 00:00（即含结束日全天）。
 * 只传一边就只限制那一边，都不传返回空对象。
 */
export function parseShanghaiDayRange(
  fromRaw?: string,
  toRaw?: string,
): { from?: Date; until?: Date } {
  const from =
    fromRaw === undefined || fromRaw.trim() === '' ? undefined : parseDay(fromRaw, '开始日期');
  const untilRaw =
    toRaw === undefined || toRaw.trim() === '' ? undefined : parseDay(toRaw, '结束日期');
  const until = untilRaw === undefined ? undefined : addShanghaiDays(untilRaw, 1);
  if (from !== undefined && until !== undefined && from.getTime() >= until.getTime()) {
    throw new BadRequestException('开始时间必须早于结束时间');
  }
  return { from, until };
}

function parseDay(raw: string, label: string): Date {
  const value = raw.trim();
  if (!isShanghaiBizDate(value)) {
    throw new BadRequestException(`${label}格式必须是 YYYY-MM-DD`);
  }
  return shanghaiAt(value, 0, 0);
}
