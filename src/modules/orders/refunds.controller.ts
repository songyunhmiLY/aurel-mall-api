import { Controller, Get, GoneException, Post, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';

/**
 * 退款接口已下线（410 Gone）。
 * 会员商城不再提供退货退款：小程序端没有任何退款入口，接口保留只为让旧版客户端拿到明确提示，
 * 而不是一个语义含糊的 404。业务实现仍保留在 RefundsService，历史记录可在管理端直链查看。
 */
@Controller()
@UseGuards(MiniProgramTokenGuard)
export class RefundsController {
  @Post('orders/:id/refunds')
  apply(): never {
    throw refundOffline();
  }

  @Get('me/refunds')
  list(): never {
    throw refundOffline();
  }

  @Get('me/refunds/:id')
  detail(): never {
    throw refundOffline();
  }
}

function refundOffline(): GoneException {
  return new GoneException('退款功能已下线，如需售后请联系客服');
}
