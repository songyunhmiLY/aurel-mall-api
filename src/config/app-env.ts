import { parseLockedRuntimeConfig, type LockedRuntimeConfig } from './locked-runtime';
import { parseRedisUrl } from './redis-url';

export interface AppEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  allowClockOverride: boolean;
  allowPreviewAuth: boolean;
  /** 时间仿真台开关。默认关闭；生产环境显式为 true 会被拒绝启动。 */
  simulationEnabled: boolean;
  /**
   * 仿真逐日推进：每个到期档位执行完后，仿真时钟前进的模拟任务耗时（分钟）。
   * 真实环境的定时任务从计划钟点开始执行并占用一段真实时间；沙箱里任务瞬时
   * 完成，用这个值把「任务占用的时间」体现在仿真时钟上。默认 5。
   */
  simulationTaskDurationMinutes: number;
  /** 待支付订单的自动关闭时长（分钟）。0 表示不自动关闭，回退为纯手动关单。 */
  orderPaymentTimeoutMinutes: number;
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
    simulationEnabled: readSimulationEnabled(source, nodeEnv),
    simulationTaskDurationMinutes: readSimulationTaskDuration(source),
    orderPaymentTimeoutMinutes: readOrderPaymentTimeout(source),
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

/**
 * 时间仿真台只在非正式环境可用。
 * 默认关闭；显式为 true 时允许。production 一律拒绝启动，
 * staging / development / test 放行，避免正式部署误开仿真。
 */
function readSimulationEnabled(source: NodeJS.ProcessEnv, nodeEnv: string): boolean {
  const enabled = readFlag(source, 'SIMULATION_ENABLED');
  if (enabled && nodeEnv === 'production') {
    throw new Error('生产环境不允许开启 SIMULATION_ENABLED（时间仿真台只在测试环境使用）');
  }
  return enabled;
}

/**
 * 仿真逐日推进的模拟任务耗时。默认 5 分钟；范围 1–120。
 * 真实环境的定时任务从计划钟点开始执行并占用一段时间；沙箱里任务瞬时完成，
 * 用这个值把「任务占用的时间」体现在仿真时钟上。
 */
function readSimulationTaskDuration(source: NodeJS.ProcessEnv): number {
  const raw = source.SIMULATION_TASK_DURATION_MINUTES;
  if (raw === undefined || raw.trim() === '') {
    return 5;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('SIMULATION_TASK_DURATION_MINUTES 必须是正整数（分钟）');
  }
  const minutes = Number(raw.trim());
  if (minutes < 1 || minutes > 120) {
    throw new Error('SIMULATION_TASK_DURATION_MINUTES 必须在 1 到 120 之间');
  }
  return minutes;
}

/** 待支付订单自动关闭时长。默认 15 分钟；0 关闭该功能（只保留手动关单）。 */
const DEFAULT_ORDER_PAYMENT_TIMEOUT_MINUTES = 15;
const MAX_ORDER_PAYMENT_TIMEOUT_MINUTES = 1440;

function readOrderPaymentTimeout(source: NodeJS.ProcessEnv): number {
  const raw = source.ORDER_PAYMENT_TIMEOUT_MINUTES;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ORDER_PAYMENT_TIMEOUT_MINUTES;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('ORDER_PAYMENT_TIMEOUT_MINUTES 必须是非负整数（分钟）');
  }
  const minutes = Number(raw.trim());
  if (minutes > MAX_ORDER_PAYMENT_TIMEOUT_MINUTES) {
    throw new Error('ORDER_PAYMENT_TIMEOUT_MINUTES 不能超过 1440（24 小时）');
  }
  return minutes;
}

/** 仓库里出现过的示例密钥。non-dev 环境出现这些值等同于没有设密码。 */
const PLACEHOLDER_SECRETS = new Set([
  'dev-admin-jwt-placeholder',
  'dev-mini-program-placeholder',
  'change-me',
  'changeme',
]);

/** 只有本机开发与单测可以偷懒用短密钥；staging 和 production 一样按正式标准要求。 */
function isLocalEnv(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

function readSecret(source: NodeJS.ProcessEnv, key: string, nodeEnv: string): string {
  const value = readRequired(source, key);
  if (value.length < 8) {
    throw new Error(`环境变量 ${key} 长度至少 8`);
  }
  if (!isLocalEnv(nodeEnv)) {
    if (PLACEHOLDER_SECRETS.has(value)) {
      throw new Error(`环境变量 ${key} 不接受示例值，请换成随机密钥`);
    }
    if (value.length < 32) {
      throw new Error(`环境变量 ${key} 长度至少 32`);
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
