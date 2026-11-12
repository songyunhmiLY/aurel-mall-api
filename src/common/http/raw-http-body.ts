/** 跳过统一 `{ code, message, data }` 包装，按给定 HTTP 状态原样返回。微信支付回调使用。 */
export class RawHttpBody {
  constructor(
    readonly status: number,
    readonly value: unknown,
  ) {}
}
