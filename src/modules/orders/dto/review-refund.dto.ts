import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_FEN } from '../order.constants';

export class ReviewRefundDto {
  @IsOptional()
  @IsInt({ message: '退款金额不正确' })
  @Min(0, { message: '退款金额不正确' })
  @Max(MAX_FEN, { message: '退款金额不正确' })
  refundFen?: number;

  @IsOptional()
  @IsInt({ message: '减扣金额不正确' })
  @Min(0, { message: '减扣金额不正确' })
  @Max(MAX_FEN, { message: '减扣金额不正确' })
  deductionFen?: number;
}
