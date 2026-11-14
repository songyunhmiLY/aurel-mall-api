/**
 * 微信已扣款、但本地结算事务失败时，用它把整个支付事务标记回滚，
 * 由 WechatPayService 在事务外登记结算补偿。
 * 不继承 HttpException：这是内部信号，不能透给客户端。
 */
export class SettlementFailedNeedsCompensation extends Error {
  readonly orderId: bigint;
  readonly payNo: string;
  readonly amountFen: number;
  readonly transactionId: string | null;
  /** 订单已被超时取消等可以预先判定的原因；结算阶段抛出的错误走 cause。 */
  readonly presetReason: string | null;
  override readonly cause: unknown;

  constructor(input: {
    orderId: bigint;
    payNo: string;
    amountFen: number;
    transactionId: string | null;
    presetReason?: string | null;
    cause: unknown;
  }) {
    super('订单结算失败，需要登记补偿');
    this.name = 'SettlementFailedNeedsCompensation';
    this.orderId = input.orderId;
    this.payNo = input.payNo;
    this.amountFen = input.amountFen;
    this.transactionId = input.transactionId;
    this.presetReason = input.presetReason ?? null;
    this.cause = input.cause;
  }
}
