/**
 * §16 只推送这些事件。全局推送方式不在这里，它对全部已开启事件一起生效。
 * 钱包入账按账户拆开。幸运返还和商城退款有自己的事件，不再各发一条钱包入账。
 * 订单支付与发货没有钱包流水，单独两个事件，只在订单状态真正变化时发一次。
 */
export const NOTIFY_EVENTS = [
  'order_paid',
  'order_shipped',
  'refund_result',
  'lucky_return_credited',
  'withdrawal_outcome',
  'wallet_credit_withdrawable',
  'wallet_credit_points',
  'wallet_credit_consumption',
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const NOTIFY_EVENT_FIELDS = {
  order_paid: ['orderNo', 'amount', 'goodsName', 'time', 'status'],
  order_shipped: ['orderNo', 'courierName', 'trackingNo', 'time', 'status'],
  refund_result: ['amount', 'time', 'orderNo', 'status'],
  lucky_return_credited: ['amount', 'pointsAmount', 'withdrawableAmount', 'time', 'orderNo'],
  withdrawal_outcome: ['amount', 'payoutAmount', 'time', 'orderNo', 'status'],
  wallet_credit_withdrawable: ['amount', 'time', 'orderNo', 'bizType'],
  wallet_credit_points: ['amount', 'time', 'orderNo', 'bizType'],
  wallet_credit_consumption: ['amount', 'time', 'orderNo', 'bizType'],
} as const satisfies Record<NotifyEvent, readonly string[]>;

export type NotifyField = (typeof NOTIFY_EVENT_FIELDS)[NotifyEvent][number];

const WALLET_CREDIT_EXCLUDED_BIZ = new Set(['filing_settlement', 'mall_refund']);

export function isNotifyEvent(value: string): value is NotifyEvent {
  return (NOTIFY_EVENTS as readonly string[]).includes(value);
}

export function isFieldForEvent(event: NotifyEvent, field: string): field is NotifyField {
  return (NOTIFY_EVENT_FIELDS[event] as readonly string[]).includes(field);
}

/** 佣金、补贴、红包及其他入账走账户开关。幸运返还和退款结果不走这里。 */
export function walletCreditNotifies(bizType: string): boolean {
  return !WALLET_CREDIT_EXCLUDED_BIZ.has(bizType);
}

export type NotifyIntent =
  | {
      type: 'order_paid';
      userId: bigint;
      orderNo: string;
      amountFen: bigint;
      /** 已截断的商品名，超过一个商品时带「等 N 件」。直接填模板空位用。 */
      goodsName: string;
      occurredAt: Date;
    }
  | {
      type: 'order_shipped';
      userId: bigint;
      orderNo: string;
      courierName: string;
      trackingNo: string;
      occurredAt: Date;
    }
  | {
      type: 'refund_result';
      userId: bigint;
      status: 'approved' | 'rejected';
      amountFen: bigint;
      orderNo: string;
      occurredAt: Date;
    }
  | {
      type: 'lucky_return_credited';
      userId: bigint;
      pointsFen: bigint;
      withdrawableFen: bigint;
      orderNo: string;
      occurredAt: Date;
    }
  | {
      type: 'withdrawal_outcome';
      userId: bigint;
      status: 'pending' | 'paid' | 'rejected';
      amountFen: bigint;
      payoutFen: bigint;
      orderNo: string;
      occurredAt: Date;
    }
  | {
      type: 'wallet_credit';
      userId: bigint;
      walletType: 'points' | 'withdrawable' | 'consumption';
      amountFen: bigint;
      bizType: string;
      bizId: string;
      occurredAt: Date;
    };

export function eventOf(intent: NotifyIntent): NotifyEvent {
  switch (intent.type) {
    case 'order_paid':
      return 'order_paid';
    case 'order_shipped':
      return 'order_shipped';
    case 'refund_result':
      return 'refund_result';
    case 'lucky_return_credited':
      return 'lucky_return_credited';
    case 'withdrawal_outcome':
      return 'withdrawal_outcome';
    case 'wallet_credit':
      if (intent.walletType === 'points') {
        return 'wallet_credit_points';
      }
      if (intent.walletType === 'withdrawable') {
        return 'wallet_credit_withdrawable';
      }
      return 'wallet_credit_consumption';
  }
}
