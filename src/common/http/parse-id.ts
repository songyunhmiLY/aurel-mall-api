import { BadRequestException } from '@nestjs/common';

const MAX_SIGNED_BIGINT = 9223372036854775807n;

export function parseOptionalId(value: string | null | undefined): bigint | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return parseRouteId(value);
}

export function parseRouteId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException('编号不正确');
  }
  const id = BigInt(raw);
  if (id <= 0n || id > MAX_SIGNED_BIGINT) {
    throw new BadRequestException('编号不正确');
  }
  return id;
}

export function parsePage(raw: string | undefined): number {
  return parseBoundedInt(raw, 1, 1, 100_000, '页码不正确');
}

export function parsePageSize(raw: string | undefined): number {
  return parseBoundedInt(raw, 20, 1, 100, '分页大小不正确');
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  message: string,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException(message);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BadRequestException(message);
  }
  return value;
}
