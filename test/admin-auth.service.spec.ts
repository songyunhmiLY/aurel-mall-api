import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AdminJwtGuard } from '../src/common/auth/admin-jwt.guard';
import { AdminTokenService } from '../src/common/auth/admin-token.service';
import type { AdminPrincipal } from '../src/common/auth/admin-principal';
import { hashPassword, verifyPassword } from '../src/common/auth/password-hasher';
import type { ClockService } from '../src/common/clock/clock.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppEnv } from '../src/config/app-env';
import { toJsonSafe } from '../src/common/http/api-response';
import { AdminAuthService } from '../src/modules/admin/admin-auth.service';

const PASSWORD = 'correct-horse';

interface AdminRow {
  id: bigint;
  username: string;
  passwordHash: string;
  displayName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

class MutableClock {
  current = new Date('2026-11-13T00:00:00.000Z');

  async now(): Promise<Date> {
    return this.current;
  }

  async realNow(): Promise<Date> {
    return this.current;
  }

  instant(unixMs: number): Date {
    return new Date(unixMs);
  }
}

function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    adminJwtSecret: 'test-secret-admin',
    adminBootstrapUsername: null,
    adminBootstrapPassword: null,
    adminBootstrapDisplayName: null,
    ...overrides,
  } as AppEnv;
}

function memoryAdmins() {
  const byUsername = new Map<string, AdminRow>();
  const byId = new Map<bigint, AdminRow>();
  let nextId = 1n;
  return {
    byUsername,
    byId,
    prisma: {
      adminUser: {
        findUnique: jest.fn(async ({ where }: { where: { username?: string; id?: bigint } }) => {
          if (where.username) {
            return byUsername.get(where.username) ?? null;
          }
          if (where.id !== undefined) {
            return byId.get(where.id) ?? null;
          }
          return null;
        }),
        create: jest.fn(async ({ data }: { data: Omit<AdminRow, 'id'> }) => {
          if (byUsername.has(data.username)) {
            const error = new Error('unique') as Error & { code: string };
            error.code = 'P2002';
            throw error;
          }
          const row: AdminRow = { id: nextId++, ...data };
          byUsername.set(row.username, row);
          byId.set(row.id, row);
          return row;
        }),
      },
    },
  };
}

describe('admin login', () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  function setup(status = 'active') {
    const clock = new MutableClock();
    const db = memoryAdmins();
    const tokens = new AdminTokenService(clock as unknown as ClockService, testEnv());
    const service = new AdminAuthService(
      db.prisma as unknown as PrismaService,
      clock as unknown as ClockService,
      tokens,
      testEnv(),
    );
    const admin: AdminRow = {
      id: 4n,
      username: 'auditor',
      passwordHash,
      displayName: '审核',
      status,
      createdAt: clock.current,
      updatedAt: clock.current,
    };
    db.byUsername.set(admin.username, admin);
    db.byId.set(admin.id, admin);
    return { clock, db, tokens, service, admin };
  }

  it('returns a bearer token for the correct password', async () => {
    const { service, tokens, admin } = setup();
    const result = await service.login('auditor', PASSWORD);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresAt).toBe('2026-11-13T12:00:00.000Z');
    expect(result.admin).toEqual({ id: admin.id, username: 'auditor', displayName: '审核' });
    const wire = JSON.stringify(toJsonSafe(result));
    expect(wire).toContain('"id":"4"');
    expect(wire).not.toContain(PASSWORD);
    expect(wire).not.toContain(passwordHash);
    await expect(tokens.verify(result.token)).resolves.toMatchObject({
      sub: admin.id,
      username: 'auditor',
    });
    expect(passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(passwordHash, PASSWORD)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const { service } = setup();
    await expect(service.login('auditor', 'wrong-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unknown username', async () => {
    const { service } = setup();
    await expect(service.login('missing', PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a disabled account even with the correct password', async () => {
    const { service } = setup('disabled');
    await expect(service.login('auditor', PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('bootstraps one admin and does not reset the password on the next start', async () => {
    const clock = new MutableClock();
    const db = memoryAdmins();
    const tokens = new AdminTokenService(clock as unknown as ClockService, testEnv());
    const service = new AdminAuthService(
      db.prisma as unknown as PrismaService,
      clock as unknown as ClockService,
      tokens,
      testEnv({
        adminBootstrapUsername: 'root',
        adminBootstrapPassword: 'bootstrap-pass',
        adminBootstrapDisplayName: '平台',
      }),
    );
    await service.onModuleInit();
    const created = db.byUsername.get('root');
    expect(created?.displayName).toBe('平台');
    expect(created?.status).toBe('active');
    expect(created?.passwordHash).not.toBe('bootstrap-pass');
    const firstHash = created?.passwordHash;
    await service.onModuleInit();
    expect(db.byUsername.get('root')?.passwordHash).toBe(firstHash);
    expect(db.prisma.adminUser.create).toHaveBeenCalledTimes(1);
    const login = await service.login('root', 'bootstrap-pass');
    expect(login.admin.username).toBe('root');
  });
});

describe('admin auth guard', () => {
  function context(authorization?: string) {
    const request: { header: (name: string) => string | undefined; admin?: AdminPrincipal } = {
      header(name: string) {
        return name.toLowerCase() === 'authorization' ? authorization : undefined;
      },
    };
    return {
      request,
      execution: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as ExecutionContext,
    };
  }

  it('rejects a request without a bearer token', async () => {
    const clock = new MutableClock();
    const db = memoryAdmins();
    const tokens = new AdminTokenService(clock as unknown as ClockService, testEnv());
    const guard = new AdminJwtGuard(tokens, db.prisma as unknown as PrismaService);
    const { execution } = context();
    await expect(guard.canActivate(execution)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a token from a successful login and rejects it after the admin is disabled', async () => {
    const clock = new MutableClock();
    const db = memoryAdmins();
    const tokens = new AdminTokenService(clock as unknown as ClockService, testEnv());
    const service = new AdminAuthService(
      db.prisma as unknown as PrismaService,
      clock as unknown as ClockService,
      tokens,
      testEnv({
        adminBootstrapUsername: 'root',
        adminBootstrapPassword: 'bootstrap-pass',
        adminBootstrapDisplayName: null,
      }),
    );
    await service.onModuleInit();
    const login = await service.login('root', 'bootstrap-pass');
    const guard = new AdminJwtGuard(tokens, db.prisma as unknown as PrismaService);
    const allowed = context(`Bearer ${login.token}`);
    await expect(guard.canActivate(allowed.execution)).resolves.toBe(true);
    expect(allowed.request.admin?.username).toBe('root');

    const admin = db.byUsername.get('root');
    if (!admin) {
      throw new Error('missing admin');
    }
    admin.status = 'disabled';
    await expect(
      guard.canActivate(context(`Bearer ${login.token}`).execution),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    clock.current = new Date('2026-11-13T12:00:00.000Z');
    admin.status = 'active';
    await expect(
      guard.canActivate(context(`Bearer ${login.token}`).execution),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
