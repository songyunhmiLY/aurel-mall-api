import { BadRequestException, Injectable } from '@nestjs/common';
import type { UserBankAccount } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface BankAccountInput {
  accountName: string;
  bankName: string;
  accountNo: string;
  branchName: string;
}

export interface BankAccountView {
  accountName: string;
  bankName: string;
  accountNo: string;
  branchName: string;
  updatedAt: string;
}

const ACCOUNT_NO = /^\d{8,30}$/;

@Injectable()
export class BankAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async get(userId: bigint): Promise<BankAccountView | null> {
    const row = await this.prisma.userBankAccount.findUnique({ where: { userId } });
    return row ? toView(row) : null;
  }

  async save(userId: bigint, input: BankAccountInput): Promise<BankAccountView> {
    const normalized = normalizeBankAccount(input);
    const now = await this.clock.now();
    const existing = await this.prisma.userBankAccount.findUnique({ where: { userId } });
    if (!existing) {
      try {
        const created = await this.prisma.userBankAccount.create({
          data: { userId, ...normalized, updatedAt: now },
        });
        return toView(created);
      } catch (error) {
        if (!isUniqueConflict(error)) {
          throw error;
        }
      }
    }
    const updated = await this.prisma.userBankAccount.update({
      where: { userId },
      data: { ...normalized, updatedAt: now },
    });
    return toView(updated);
  }
}

export function normalizeBankAccount(input: BankAccountInput): BankAccountInput {
  return {
    accountName: requiredText(input.accountName, 64, '开户名不正确'),
    bankName: requiredText(input.bankName, 64, '开户银行不正确'),
    accountNo: requiredAccountNo(input.accountNo),
    branchName: requiredText(input.branchName, 128, '开户支行不正确'),
  };
}

function requiredText(value: string, max: number, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new BadRequestException(message);
  }
  return trimmed;
}

function requiredAccountNo(value: string): string {
  const trimmed = value.trim();
  if (!ACCOUNT_NO.test(trimmed)) {
    throw new BadRequestException('银行卡号不正确');
  }
  return trimmed;
}

function toView(row: UserBankAccount): BankAccountView {
  return {
    accountName: row.accountName,
    bankName: row.bankName,
    accountNo: row.accountNo,
    branchName: row.branchName,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
