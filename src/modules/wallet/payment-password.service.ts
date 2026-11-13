import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { hashPassword, verifyPassword } from '../../common/auth/password-hasher';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const PASSWORD_PATTERN = /^\S{6,64}$/;

/**
 * 支付密码只在消费账户划转确认时校验。
 * TODO: 需求没有规定位数和字符集，这里暂按 6 到 64 位且不含空白。
 */
@Injectable()
export class PaymentPasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async status(userId: bigint): Promise<{ set: boolean }> {
    const row = await this.prisma.userPaymentPassword.findUnique({ where: { userId } });
    return { set: row !== null };
  }

  async set(userId: bigint, password: string): Promise<{ set: true }> {
    if (!PASSWORD_PATTERN.test(password)) {
      throw new BadRequestException('支付密码格式不正确');
    }
    const existing = await this.prisma.userPaymentPassword.findUnique({ where: { userId } });
    if (existing) {
      throw new ConflictException('支付密码已设置');
    }
    const now = await this.clock.now();
    const passwordHash = await hashPassword(password);
    if (passwordHash.length > 255) {
      throw new BadRequestException('支付密码格式不正确');
    }
    try {
      await this.prisma.userPaymentPassword.create({
        data: { userId, passwordHash, updatedAt: now },
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('支付密码已设置');
      }
      throw error;
    }
    return { set: true };
  }

  async assertMatches(userId: bigint, password: string): Promise<void> {
    const row = await this.prisma.userPaymentPassword.findUnique({ where: { userId } });
    if (!row) {
      throw new BadRequestException('请先设置支付密码');
    }
    const matched = await verifyPassword(row.passwordHash, password);
    if (!matched) {
      throw new BadRequestException('支付密码错误');
    }
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
