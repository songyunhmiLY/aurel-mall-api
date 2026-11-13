import { Module } from '@nestjs/common';
import { AuthModule } from '../../common/auth/auth.module';
import { ClockModule } from '../../common/clock/clock.module';
import { UsersModule } from '../users/users.module';
import { BankAccountController } from './bank-account.controller';
import { BankAccountService } from './bank-account.service';
import { CashLedgerService } from './cash-ledger.service';
import { DisplayNameAdminController } from './display-name-admin.controller';
import { DisplayNameService } from './display-name.service';
import { PaymentPasswordController } from './payment-password.controller';
import { PaymentPasswordService } from './payment-password.service';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { WalletAdminController } from './wallet-admin.controller';
import { WalletAdminService } from './wallet-admin.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WithdrawalAdminController } from './withdrawal-admin.controller';
import { WithdrawalController } from './withdrawal.controller';
import { WithdrawalService } from './withdrawal.service';

@Module({
  imports: [AuthModule, ClockModule, UsersModule],
  controllers: [
    WalletController,
    PaymentPasswordController,
    BankAccountController,
    TransferController,
    WithdrawalController,
    WithdrawalAdminController,
    DisplayNameAdminController,
    WalletAdminController,
  ],
  providers: [
    WalletService,
    WalletAdminService,
    CashLedgerService,
    PaymentPasswordService,
    BankAccountService,
    TransferService,
    WithdrawalService,
    DisplayNameService,
  ],
  exports: [WalletService, CashLedgerService],
})
export class WalletModule {}
