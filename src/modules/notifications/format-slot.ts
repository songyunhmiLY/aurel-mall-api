import { formatShanghaiMinute } from '../../common/clock/shanghai-calendar';
import type { NotifyIntent } from '../../common/notify/notify-intent';

/** 模板空位里的金额是元，保留两位小数。不用浮点。 */
export function formatYuan(fen: bigint): string {
  const sign = fen < 0n ? '-' : '';
  const abs = fen < 0n ? -fen : fen;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole.toString()}.${fraction}`;
}

const ORDER_BIZ = /^order:(\d+)(?::layer:\d+)?$/;

export function orderIdFromBiz(bizId: string): bigint | null {
  const match = ORDER_BIZ.exec(bizId);
  const digits = match?.[1];
  if (!digits) {
    return null;
  }
  return BigInt(digits);
}

/**
 * 填进模板预留空位的业务数据。不拼整段正文。
 * status 用系统里已有的状态码。金额是元。时间是上海时间的分钟。
 */
export function slotValues(intent: NotifyIntent, orderNo: string): Record<string, string> {
  const time = formatShanghaiMinute(intent.occurredAt);
  switch (intent.type) {
    case 'order_paid':
      return {
        orderNo: intent.orderNo,
        amount: formatYuan(intent.amountFen),
        goodsName: intent.goodsName,
        time,
        status: 'paid',
      };
    case 'order_shipped':
      return {
        orderNo: intent.orderNo,
        courierName: intent.courierName,
        trackingNo: intent.trackingNo,
        time,
        status: 'shipped',
      };
    case 'refund_result':
      return {
        amount: formatYuan(intent.amountFen),
        time,
        orderNo: intent.orderNo,
        status: intent.status,
      };
    case 'lucky_return_credited':
      return {
        amount: formatYuan(intent.pointsFen + intent.withdrawableFen),
        pointsAmount: formatYuan(intent.pointsFen),
        withdrawableAmount: formatYuan(intent.withdrawableFen),
        time,
        orderNo: intent.orderNo,
      };
    case 'withdrawal_outcome':
      return {
        amount: formatYuan(intent.amountFen),
        payoutAmount: formatYuan(intent.payoutFen),
        time,
        orderNo: intent.orderNo,
        status: intent.status,
      };
    case 'wallet_credit':
      return {
        amount: formatYuan(intent.amountFen),
        time,
        orderNo,
        bizType: intent.bizType,
      };
  }
}
