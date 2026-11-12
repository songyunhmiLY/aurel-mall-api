export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
}

export function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL 不是合法的 URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL 协议必须是 redis 或 rediss');
  }
  const dbRaw = url.pathname.replace(/^\//, '');
  const db = dbRaw === '' ? undefined : Number(dbRaw);
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) {
    throw new Error('REDIS_URL 数据库编号不合法');
  }
  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REDIS_URL 端口不合法');
  }
  return {
    host: url.hostname,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(db !== undefined ? { db } : {}),
  };
}

export function toBullMqConnection(redisUrl: string): Record<string, unknown> {
  const parsed = parseRedisUrl(redisUrl);
  return {
    host: parsed.host,
    port: parsed.port,
    maxRetriesPerRequest: null,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.db !== undefined ? { db: parsed.db } : {}),
    ...(redisUrl.startsWith('rediss:') ? { tls: {} } : {}),
  };
}
