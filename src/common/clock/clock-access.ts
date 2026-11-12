import type { Request } from 'express';

export interface ClockCaller {
  hostHeader?: string;
  forwardedHost?: string;
  remoteAddress?: string;
}

export function extractClockCaller(req: Request): ClockCaller {
  const forwarded = req.header('x-forwarded-host');
  return {
    ...(req.header('host') ? { hostHeader: req.header('host') } : {}),
    ...(forwarded ? { forwardedHost: forwarded.split(',')[0]?.trim() } : {}),
    ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
  };
}

/**
 * 允许覆盖的调用方：主机名包含 test，或来源是 localhost / 127.0.0.1 / 192.168.*。
 * 主机名判断按子串包含 test（因此 contest 也会命中）。生产环境靠 ALLOW_CLOCK_OVERRIDE=false 关掉整条路径。
 */
export function isClockOverrideCallerAllowed(caller: ClockCaller): boolean {
  const hosts = [caller.forwardedHost, caller.hostHeader];
  if (hosts.some((host) => hostAllowsOverride(host))) {
    return true;
  }
  return isLocalAddress(caller.remoteAddress);
}

export function normalizeHost(raw: string | undefined): string {
  if (!raw) {
    return '';
  }
  let value = raw.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 1 ? value.slice(1, end) : value;
  }
  if (value.includes(':') && value.indexOf(':') === value.lastIndexOf(':')) {
    value = value.slice(0, value.indexOf(':'));
  }
  return value;
}

function hostAllowsOverride(raw: string | undefined): boolean {
  const host = normalizeHost(raw);
  if (!host) {
    return false;
  }
  if (isLocalHostname(host)) {
    return true;
  }
  return host.includes('test');
}

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || isRfc1918Host(host);
}

function isLocalAddress(raw: string | undefined): boolean {
  const host = normalizeIp(raw);
  return isLocalHostname(host);
}

function isRfc1918Host(host: string): boolean {
  return /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host);
}

function normalizeIp(raw: string | undefined): string {
  if (!raw) {
    return '';
  }
  const value = raw.trim().toLowerCase();
  if (value.startsWith('::ffff:')) {
    return value.slice('::ffff:'.length);
  }
  return value;
}
