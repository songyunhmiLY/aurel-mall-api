import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { isShanghaiBizDate } from '../../common/clock/shanghai-calendar';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isScheduleCycle } from './cofounder-schedule';
import {
  COFOUNDER_ENTRY_COPY_KEY,
  COFOUNDER_ENTRY_COPY_MAX,
  COFOUNDER_ENTRY_IMAGES_KEY,
  COFOUNDER_IMAGE_COUNT_MAX,
  COFOUNDER_IMAGE_MAX,
  COFOUNDER_INTRO_BODY_KEY,
  COFOUNDER_INTRO_BODY_MAX,
  COFOUNDER_INTRO_IMAGES_KEY,
  COFOUNDER_INTRO_TITLE_KEY,
  COFOUNDER_INTRO_TITLE_MAX,
  COFOUNDER_SETTINGS_KEY,
  MAX_ACTIVATION_FEN,
  MAX_FEN,
  MAX_SEAT_CAP,
  PAYOUT_MODES,
  PAYOUT_PER_PERSON,
  PAYOUT_PERIODIC,
  PAYOUT_POOL_TOTAL,
  defaultCofounderSettings,
  type CofounderSchedule,
  type CofounderSettings,
  type PayoutMode,
  type Tx,
} from './cofounder.constants';

export interface CofounderContent {
  entryCopy: string;
  entryImageUrls: string[];
  introTitle: string;
  introBody: string;
  introImageUrls: string[];
}

type SettingDb = {
  adminSetting: PrismaService['adminSetting'];
};

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 管理员可改的联合创始人配置和入口文案。
 * 分红比例不在这里，启动时从环境变量读入。
 */
@Injectable()
export class CofounderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async get(): Promise<CofounderSettings> {
    return this.readFrom(this.prisma);
  }

  async readFrom(db: SettingDb): Promise<CofounderSettings> {
    const row = await db.adminSetting.findUnique({
      where: { settingKey: COFOUNDER_SETTINGS_KEY },
    });
    if (!row) {
      return defaultCofounderSettings();
    }
    return parseStoredSettings(row.settingValue);
  }

  async write(tx: Tx, settings: CofounderSettings, adminId: bigint, now: Date): Promise<void> {
    const settingValue = JSON.stringify(serializeSettings(settings));
    await this.writeKey(tx, COFOUNDER_SETTINGS_KEY, settingValue, adminId, now);
  }

  async getContent(): Promise<CofounderContent> {
    const [copy, entryImages, title, body, introImages] = await Promise.all([
      this.prisma.adminSetting.findUnique({ where: { settingKey: COFOUNDER_ENTRY_COPY_KEY } }),
      this.prisma.adminSetting.findUnique({ where: { settingKey: COFOUNDER_ENTRY_IMAGES_KEY } }),
      this.prisma.adminSetting.findUnique({ where: { settingKey: COFOUNDER_INTRO_TITLE_KEY } }),
      this.prisma.adminSetting.findUnique({ where: { settingKey: COFOUNDER_INTRO_BODY_KEY } }),
      this.prisma.adminSetting.findUnique({ where: { settingKey: COFOUNDER_INTRO_IMAGES_KEY } }),
    ]);
    return {
      entryCopy: copy?.settingValue ?? '',
      entryImageUrls: parseImages(entryImages?.settingValue),
      introTitle: title?.settingValue ?? '',
      introBody: body?.settingValue ?? '',
      introImageUrls: parseImages(introImages?.settingValue),
    };
  }

  async setContent(input: CofounderContent, adminId: bigint): Promise<CofounderContent> {
    const content = normalizeContent(input);
    const now = await this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.writeKey(tx, COFOUNDER_ENTRY_COPY_KEY, content.entryCopy, adminId, now);
      await this.writeKey(
        tx,
        COFOUNDER_ENTRY_IMAGES_KEY,
        JSON.stringify(content.entryImageUrls),
        adminId,
        now,
      );
      await this.writeKey(tx, COFOUNDER_INTRO_TITLE_KEY, content.introTitle, adminId, now);
      await this.writeKey(tx, COFOUNDER_INTRO_BODY_KEY, content.introBody, adminId, now);
      await this.writeKey(
        tx,
        COFOUNDER_INTRO_IMAGES_KEY,
        JSON.stringify(content.introImageUrls),
        adminId,
        now,
      );
    });
    return content;
  }

  async closeUserButton(tx: Tx, adminId: bigint | null, now: Date): Promise<void> {
    const current = await this.readFrom(tx);
    if (!current.userButtonOpen) {
      return;
    }
    await this.write(tx, { ...current, userButtonOpen: false }, adminId ?? 0n, now);
  }

  private async writeKey(
    tx: Tx,
    settingKey: string,
    settingValue: string,
    adminId: bigint,
    now: Date,
  ): Promise<void> {
    const existing = await tx.adminSetting.findUnique({ where: { settingKey } });
    if (existing) {
      await tx.adminSetting.update({
        where: { id: existing.id },
        data: { settingValue, updatedAt: now, updatedByAdminId: adminId > 0n ? adminId : null },
      });
      return;
    }
    await tx.adminSetting.create({
      data: {
        settingKey,
        settingValue,
        updatedAt: now,
        updatedByAdminId: adminId > 0n ? adminId : null,
      },
    });
  }
}

export function assertSettingsInput(input: CofounderSettings): CofounderSettings {
  if (!Number.isInteger(input.seatCap) || input.seatCap < 0 || input.seatCap > MAX_SEAT_CAP) {
    throw new BadRequestException('名额上限不正确');
  }
  if (input.activationAmountFen < 0n || input.activationAmountFen > BigInt(MAX_ACTIVATION_FEN)) {
    throw new BadRequestException('开通金额不正确');
  }
  if (!(PAYOUT_MODES as readonly string[]).includes(input.payoutMode)) {
    throw new BadRequestException('分配方式不正确');
  }
  assertSchedule(input.schedule);
  if (input.poolThresholdFen < 0n || input.poolThresholdFen > MAX_FEN) {
    throw new BadRequestException('池子总额不正确');
  }
  if (input.perPersonThresholdFen < 0n || input.perPersonThresholdFen > MAX_FEN) {
    throw new BadRequestException('人均额度不正确');
  }
  if (input.payoutMode === PAYOUT_POOL_TOTAL && input.poolThresholdFen <= 0n) {
    throw new BadRequestException('按池子总额分配需要大于 0 的门槛');
  }
  if (input.payoutMode === PAYOUT_PER_PERSON && input.perPersonThresholdFen <= 0n) {
    throw new BadRequestException('按人均额度分配需要大于 0 的门槛');
  }
  if (input.payoutMode === PAYOUT_PERIODIC && input.schedule.cycle === 'interval') {
    if (!isShanghaiBizDate(input.schedule.anchorDate)) {
      throw new BadRequestException('间隔周期需要起始日期');
    }
  }
  return input;
}

function assertSchedule(schedule: CofounderSchedule): void {
  if (!isScheduleCycle(schedule.cycle)) {
    throw new BadRequestException('发放周期不正确');
  }
  if (!CLOCK_TIME.test(schedule.time)) {
    throw new BadRequestException('发放时刻不正确');
  }
  if (!Number.isInteger(schedule.weekday) || schedule.weekday < 1 || schedule.weekday > 7) {
    throw new BadRequestException('每周发放日不正确');
  }
  if (!Number.isInteger(schedule.monthDay) || schedule.monthDay < 1 || schedule.monthDay > 31) {
    throw new BadRequestException('每月发放日不正确');
  }
  if (
    !Number.isInteger(schedule.intervalDays) ||
    schedule.intervalDays < 1 ||
    schedule.intervalDays > 366
  ) {
    throw new BadRequestException('间隔天数不正确');
  }
  if (!isShanghaiBizDate(schedule.anchorDate)) {
    throw new BadRequestException('起始日期不正确');
  }
}

function serializeSettings(settings: CofounderSettings): Record<string, unknown> {
  return {
    seatCap: settings.seatCap,
    userButtonOpen: settings.userButtonOpen,
    activationAmountFen: settings.activationAmountFen.toString(),
    payoutMode: settings.payoutMode,
    schedule: settings.schedule,
    poolThresholdFen: settings.poolThresholdFen.toString(),
    perPersonThresholdFen: settings.perPersonThresholdFen.toString(),
  };
}

function parseStoredSettings(raw: string): CofounderSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestException('联合创始人配置无法读取');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException('联合创始人配置无法读取');
  }
  const record = parsed as Record<string, unknown>;
  const schedule = record.schedule;
  if (!schedule || typeof schedule !== 'object') {
    throw new BadRequestException('联合创始人配置无法读取');
  }
  const cycle = (schedule as { cycle?: unknown }).cycle;
  const settings: CofounderSettings = {
    seatCap: requireInt(record.seatCap, '名额上限不正确'),
    userButtonOpen: record.userButtonOpen === true,
    activationAmountFen: requireFen(record.activationAmountFen, '开通金额不正确'),
    payoutMode: requireMode(record.payoutMode),
    schedule: {
      cycle: typeof cycle === 'string' && isScheduleCycle(cycle) ? cycle : 'daily',
      time:
        typeof (schedule as { time?: unknown }).time === 'string'
          ? (schedule as { time: string }).time
          : '00:00',
      weekday: requireInt((schedule as { weekday?: unknown }).weekday, '每周发放日不正确'),
      monthDay: requireInt((schedule as { monthDay?: unknown }).monthDay, '每月发放日不正确'),
      intervalDays: requireInt(
        (schedule as { intervalDays?: unknown }).intervalDays,
        '间隔天数不正确',
      ),
      anchorDate:
        typeof (schedule as { anchorDate?: unknown }).anchorDate === 'string'
          ? (schedule as { anchorDate: string }).anchorDate
          : '2026-01-01',
    },
    poolThresholdFen: requireFen(record.poolThresholdFen, '池子总额不正确'),
    perPersonThresholdFen: requireFen(record.perPersonThresholdFen, '人均额度不正确'),
  };
  return assertSettingsInput(settings);
}

function requireMode(value: unknown): PayoutMode {
  if (typeof value !== 'string' || !(PAYOUT_MODES as readonly string[]).includes(value)) {
    throw new BadRequestException('分配方式不正确');
  }
  return value as PayoutMode;
}

function requireInt(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestException(message);
  }
  return value;
}

function requireFen(value: unknown, message: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(message);
  }
  return BigInt(value);
}

function normalizeContent(input: CofounderContent): CofounderContent {
  return {
    entryCopy: boundedText(input.entryCopy, COFOUNDER_ENTRY_COPY_MAX, '入口文案过长'),
    entryImageUrls: normalizeImages(input.entryImageUrls),
    introTitle: boundedText(input.introTitle, COFOUNDER_INTRO_TITLE_MAX, '介绍标题过长'),
    introBody: boundedText(input.introBody, COFOUNDER_INTRO_BODY_MAX, '介绍正文过长'),
    introImageUrls: normalizeImages(input.introImageUrls),
  };
}

function boundedText(value: string, max: number, message: string): string {
  const text = value.trim();
  if (text.length > max) {
    throw new BadRequestException(message);
  }
  return text;
}

function normalizeImages(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > COFOUNDER_IMAGE_COUNT_MAX) {
    throw new BadRequestException('图片数量过多');
  }
  return values.map((value) => {
    const url = value.trim();
    if (url.length < 1 || url.length > COFOUNDER_IMAGE_MAX) {
      throw new BadRequestException('图片地址不正确');
    }
    return url;
  });
}

function parseImages(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}
