import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { SetPaymentPasswordDto } from './dto/payment-password.dto';
import { PaymentPasswordService } from './payment-password.service';

@Controller('me/payment-password')
@UseGuards(MiniProgramTokenGuard)
export class PaymentPasswordController {
  constructor(private readonly passwords: PaymentPasswordService) {}

  @Get()
  status(@CurrentUser() user: UserPrincipal) {
    return this.passwords.status(user.id);
  }

  @Post()
  @HttpCode(200)
  set(@CurrentUser() user: UserPrincipal, @Body() body: SetPaymentPasswordDto) {
    return this.passwords.set(user.id, body.password);
  }
}
