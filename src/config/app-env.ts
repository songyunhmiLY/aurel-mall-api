import { parseLockedRuntimeConfig, type LockedRuntimeConfig } from './locked-runtime';
import { parseRedisUrl } from './redis-url';

export interface AppEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  allowClockOverride: boolean;
  adminJwtSecret: string;
  miniProgramTokenSecret: string;
  marketingManagerMarketThresholdDefault: string;
  locked: LockedRuntimeConfig;
}

export function parseAppEnv(source: NodeJS.ProcessEnv): AppEnv {
  const databaseUrl = readDatabaseUrl(source);
  const redisUrl = readRequired(source, 'REDIS_URL');
  parseRedisUrl(redisUrl);

  return Object.freeze({
    nodeEnv: source.NODE_ENV?.trim() || 'development',
    port: readPort(source),
    databaseUrl,
    redisUrl,
    allowClockOverride: readFlag(source, 'ALLOW_CLOCK_OVERRIDE'),
    adminJwtSecret: readSecret(source, 'JWT_ADMIN_SECRET'),
    miniProgramTokenSecret: readSecret(source, 'MINI_PROGRAM_TOKEN_SECRET'),
    marketingManagerMarketThresholdDefault: readThresholdDefault(source),
    locked: parseLockedRuntimeConfig(source),
  });
}

function readDatabaseUrl(source: NodeJS.ProcessEnv): string {
  const value = readRequired(source, 'DATABASE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL 不是合法的 URL');
  }
  if (url.protocol !== 'mysql:') {
    throw new Error('DATABASE_URL 协议必须是 mysql');
  }
  return value;
}

function readPort(source: NodeJS.ProcessEnv): number {
  const raw = source.PORT;
  if (raw === undefined || raw.trim() === '') {
    return 3000;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('环境变量 PORT 必须是整数');
  }
  const port = Number(raw.trim());
  if (port < 1 || port > 65535) {
    throw new Error('环境变量 PORT 超出范围');
  }
  return port;
}

function readFlag(source: NodeJS.ProcessEnv, key: string): boolean {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') {
    return false;
  }
  if (raw.trim() === 'true') {
    return true;
  }
  if (raw.trim() === 'false') {
    return false;
  }
  throw new Error(`环境变量 ${key} 只能是 true 或 false`);
}

function readSecret(source: NodeJS.ProcessEnv, key: string): string {
  const value = readRequired(source, key);
  if (value.length < 8) {
    throw new Error(`环境变量 ${key} 长度至少 8`);
  }
  return value;
}

function readThresholdDefault(source: NodeJS.ProcessEnv): string {
  const value = readRequired(source, 'MARKETING_MANAGER_MARKET_THRESHOLD_DEFAULT');
  if (!/^\d+$/.test(value)) {
    throw new Error('MARKETING_MANAGER_MARKET_THRESHOLD_DEFAULT 必须是非负整数');
  }
  return value;
}

function readRequired(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少环境变量 ${key}`);
  }
  return value.trim();
}
