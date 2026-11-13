import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  STUDIO_EXTERNAL_NAME_DEFAULT,
  STUDIO_EXTERNAL_NAME_KEY,
  STUDIO_EXTERNAL_NAME_MAX,
  type Tx,
} from './studio.constants';

/**
 * 工作室对外名称。默认「补贴」。
 * 比例不在这里，启动时从环境变量读入。改名称也不改可提现分类。
 */
@Injectable()
export class StudioSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async getExternalName(): Promise<string> {
    const row = await this.prisma.adminSetting.findUnique({
      where: { settingKey: STUDIO_EXTERNAL_NAME_KEY },
    });
    return normalizeStoredName(row?.settingValue);
  }

  async setExternalName(raw: string, adminId: bigint): Promise<{ externalName: string }> {
    const externalName = assertExternalName(raw);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.writeName(tx, externalName, adminId, now);
    });
    return { externalName };
  }

  private async writeName(tx: Tx, externalName: string, adminId: bigint, now: Date): Promise<void> {
    const existing = await tx.adminSetting.findUnique({
      where: { settingKey: STUDIO_EXTERNAL_NAME_KEY },
    });
    if (existing) {
      await tx.adminSetting.update({
        where: { id: existing.id },
        data: {
          settingValue: externalName,
          updatedAt: now,
          updatedByAdminId: adminId > 0n ? adminId : null,
        },
      });
      return;
    }
    await tx.adminSetting.create({
      data: {
        settingKey: STUDIO_EXTERNAL_NAME_KEY,
        settingValue: externalName,
        updatedAt: now,
        updatedByAdminId: adminId > 0n ? adminId : null,
      },
    });
  }
}

export function assertExternalName(raw: string): string {
  const externalName = raw.trim();
  if (externalName.length < 1 || externalName.length > STUDIO_EXTERNAL_NAME_MAX) {
    throw new BadRequestException('名称不正确');
  }
  return externalName;
}

function normalizeStoredName(stored: string | undefined): string {
  if (stored === undefined) {
    return STUDIO_EXTERNAL_NAME_DEFAULT;
  }
  const externalName = stored.trim();
  if (externalName.length < 1 || externalName.length > STUDIO_EXTERNAL_NAME_MAX) {
    return STUDIO_EXTERNAL_NAME_DEFAULT;
  }
  return externalName;
}
