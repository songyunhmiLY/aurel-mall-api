import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { BankAccountService } from './bank-account.service';
import { SaveBankAccountDto } from './dto/bank-account.dto';

@Controller('me/bank-account')
@UseGuards(MiniProgramTokenGuard)
export class BankAccountController {
  constructor(private readonly accounts: BankAccountService) {}

  @Get()
  get(@CurrentUser() user: UserPrincipal) {
    return this.accounts.get(user.id);
  }

  @Put()
  save(@CurrentUser() user: UserPrincipal, @Body() body: SaveBankAccountDto) {
    return this.accounts.save(user.id, body);
  }
}
