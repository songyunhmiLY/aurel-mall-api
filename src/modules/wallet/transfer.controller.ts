import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { parseRouteId } from '../../common/http/parse-id';
import { CreateTransferDto, LookupTransferDto } from './dto/transfer.dto';
import { TransferService } from './transfer.service';

@Controller('me/transfers')
@UseGuards(MiniProgramTokenGuard)
export class TransferController {
  constructor(private readonly transfers: TransferService) {}

  @Post('lookup')
  @HttpCode(200)
  lookup(@CurrentUser() user: UserPrincipal, @Body() body: LookupTransferDto) {
    return this.transfers.lookup(user.id, parseRouteId(body.payeeId));
  }

  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: UserPrincipal, @Body() body: CreateTransferDto) {
    return this.transfers.transfer(user.id, {
      payeeUserId: parseRouteId(body.payeeId),
      amountFen: BigInt(body.amountFen),
      paymentPassword: body.paymentPassword,
    });
  }
}
