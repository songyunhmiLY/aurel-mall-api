import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { UserAddress } from '@prisma/client';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface AddressInput {
  contactName: string;
  contactPhone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
}

export interface AddressView {
  id: bigint;
  contactName: string;
  contactPhone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async list(userId: bigint): Promise<AddressView[]> {
    const rows = await this.prisma.userAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toView);
  }

  async create(userId: bigint, input: AddressInput): Promise<AddressView> {
    const data = normalizeAddress(input);
    const now = await this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.userAddress.updateMany({
          where: { userId },
          data: { isDefault: false, updatedAt: now },
        });
      }
      return tx.userAddress.create({
        data: {
          userId,
          ...data,
          createdAt: now,
          updatedAt: now,
        },
      });
    });
    return toView(row);
  }

  async update(userId: bigint, id: bigint, input: AddressInput): Promise<AddressView> {
    await this.requireOwned(userId, id);
    const data = normalizeAddress(input);
    const now = await this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.userAddress.updateMany({
          where: { userId },
          data: { isDefault: false, updatedAt: now },
        });
      }
      return tx.userAddress.update({
        where: { id },
        data: { ...data, updatedAt: now },
      });
    });
    return toView(row);
  }

  async remove(userId: bigint, id: bigint): Promise<{ id: bigint }> {
    await this.requireOwned(userId, id);
    await this.prisma.userAddress.delete({ where: { id } });
    return { id };
  }

  async setDefault(userId: bigint, id: bigint): Promise<AddressView> {
    await this.requireOwned(userId, id);
    const now = await this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.userAddress.updateMany({
        where: { userId },
        data: { isDefault: false, updatedAt: now },
      });
      return tx.userAddress.update({
        where: { id },
        data: { isDefault: true, updatedAt: now },
      });
    });
    return toView(row);
  }

  private async requireOwned(userId: bigint, id: bigint): Promise<UserAddress> {
    const row = await this.prisma.userAddress.findFirst({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException('地址不存在');
    }
    return row;
  }
}

function normalizeAddress(input: AddressInput): AddressInput {
  if (typeof input.isDefault !== 'boolean') {
    throw new BadRequestException('默认地址标记不正确');
  }
  return {
    contactName: requiredText(input.contactName, '收货人', 64),
    contactPhone: requiredText(input.contactPhone, '手机号', 32),
    province: requiredText(input.province, '省', 32),
    city: requiredText(input.city, '市', 32),
    district: requiredText(input.district, '区', 32),
    detail: requiredText(input.detail, '详细地址', 255),
    isDefault: input.isDefault,
  };
}

function requiredText(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new BadRequestException(`${label}不正确`);
  }
  return trimmed;
}

function toView(row: UserAddress): AddressView {
  return {
    id: row.id,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    province: row.province,
    city: row.city,
    district: row.district,
    detail: row.detail,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
