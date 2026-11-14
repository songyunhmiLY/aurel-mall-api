import { parseLockedRuntimeConfig, type LockedRuntimeConfig } from './locked-runtime';
import { parseRedisUrl } from './redis-url';

export interface AppEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  allowClockOverride: boolean;
  allowPreviewAuth: boolean;
  adminJwtSecret: string;
  miniProgramTokenSecret: string;
  /** 允许跨域访问的前端源。为空表示只接受同源请求（生产建议用 nginx 反代）。 */
  corsOrigins: string[];
  wechatMiniAppId: string | null;
  wechatMiniAppSecret: string | null;
  adminBootstrapUsername: string | null;
  adminBootstrapPassword: string | null;
  adminBootstrapDisplayName: string | null;
  wechatPayNotifyUrl: string | null;
  marketingManagerMarketThresholdDefault: string;
  locked: LockedRuntimeConfig;
}

export function parseAppEnv(source: NodeJS.ProcessEnv): AppEnv {
  const databaseUrl = readDatabaseUrl(source);
  const redisUrl = readRequired(source, 'REDIS_URL');
  parseRedisUrl(redisUrl);

  const nodeEnv = source.NODE_ENV?.trim() || 'development';

  return Object.freeze({
    nodeEnv,
    port: readPort(source),
    databaseUrl,
    redisUrl,
    allowClockOverride: readFlag(source, 'ALLOW_CLOCK_OVERRIDE'),
    allowPreviewAuth: readFlag(source, 'ALLOW_PREVIEW_AUTH'),
    adminJwtSecret: readSecret(source, 'JWT_ADMIN_SECRET', nodeEnv),
    miniProgramTokenSecret: readSecret(source, 'MINI_PROGRAM_TOKEN_SECRET', nodeEnv),
    corsOrigins: readCorsOrigins(source),
    wechatMiniAppId: readOptional(source, 'WECHAT_MINI_APP_ID'),
    wechatMiniAppSecret: readOptional(source, 'WECHAT_MINI_APP_SECRET'),
    ...readAdminBootstrap(source),
    wechatPayNotifyUrl: readNotifyUrl(source),
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

/** 仓库里出现过的示例密钥。生产环境出现这些值等同于没有设密码。 */
const PLACEHOLDER_SECRETS = new Set([
  'dev-admin-jwt-placeholder',
  'dev-mini-program-placeholder',
  'change-me',
  'changeme',
]);

function readSecret(source: NodeJS.ProcessEnv, key: string, nodeEnv: string): string {
  const value = readRequired(source, key);
  if (value.length < 8) {
    throw new Error(`环境变量 ${key} 长度至少 8`);
  }
  if (nodeEnv === 'production') {
    if (PLACEHOLDER_SECRETS.has(value)) {
      throw new Error(`生产环境不接受 ${key} 的示例值，请换成随机密钥`);
    }
    if (value.length < 32) {
      throw new Error(`生产环境 ${key} 长度至少 32`);
    }
  }
  return value;
}

/**
 * 前端跨域白名单，逗号分隔。
 * 留空表示不开 CORS：只接受同源请求，生产环境应由 nginx 把 /api 反代到本服务。
 */
function readCorsOrigins(source: NodeJS.ProcessEnv): string[] {
  const raw = readOptional(source, 'CORS_ORIGINS');
  if (!raw) {
    return [];
  }
  const origins = raw
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter((item) => item.length > 0);
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error('CORS_ORIGINS 不接受通配符，请逐个列出来源');
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS 中的 ${origin} 不是合法的 URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`CORS_ORIGINS 中的 ${origin} 协议必须是 http 或 https`);
    }
    if (url.origin !== origin) {
      throw new Error(`CORS_ORIGINS 中的 ${origin} 只能是协议加主机加端口，不能带路径`);
    }
  }
  return origins;
}

function readThresholdDefault(source: NodeJS.ProcessEnv): string {
  const value = readRequired(source, 'MARKETING_MANAGER_MARKET_THRESHOLD_DEFAULT');
  if (!/^\d+$/.test(value)) {
    throw new Error('MARKETING_MANAGER_MARKET_THRESHOLD_DEFAULT 必须是非负整数');
  }
  return value;
}

function readAdminBootstrap(source: NodeJS.ProcessEnv): {
  adminBootstrapUsername: string | null;
  adminBootstrapPassword: string | null;
  adminBootstrapDisplayName: string | null;
} {
  const username = readOptional(source, 'ADMIN_BOOTSTRAP_USERNAME');
  const password = readOptional(source, 'ADMIN_BOOTSTRAP_PASSWORD');
  const displayName = readOptional(source, 'ADMIN_BOOTSTRAP_DISPLAY_NAME');
  if (!username && !password && !displayName) {
    return {
      adminBootstrapUsername: null,
      adminBootstrapPassword: null,
      adminBootstrapDisplayName: null,
    };
  }
  if (!username || !password) {
    throw new Error(
      'ADMIN_BOOTSTRAP_USERNAME 和 ADMIN_BOOTSTRAP_PASSWORD 必须同时填写，或同时留空',
    );
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
    throw new Error('ADMIN_BOOTSTRAP_USERNAME 只能包含字母、数字、点、下划线和中划线，最长 64');
  }
  if (password.length < 8 || password.length > 128) {
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD 长度须在 8 到 128 之间');
  }
  if (displayName && displayName.length > 64) {
    throw new Error('ADMIN_BOOTSTRAP_DISPLAY_NAME 最长 64');
  }
  return {
    adminBootstrapUsername: username,
    adminBootstrapPassword: password,
    adminBootstrapDisplayName: displayName,
  };
}

function readNotifyUrl(source: NodeJS.ProcessEnv): string | null {
  const value = readOptional(source, 'WECHAT_PAY_NOTIFY_URL');
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WECHAT_PAY_NOTIFY_URL 不是合法的 URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('WECHAT_PAY_NOTIFY_URL 协议必须是 http 或 https');
  }
  return value;
}

function readOptional(source: NodeJS.ProcessEnv, key: string): string | null {
  const value = source[key];
  if (value === undefined || value.trim() === '') {
    return null;
  }
  return value.trim();
}

function readRequired(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少环境变量 ${key}`);
  }
  return value.trim();
}
