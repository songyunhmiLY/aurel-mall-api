import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../src/common/auth/mini-program-token.guard';
import { toJsonSafe } from '../src/common/http/api-response';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import {
  IDENTITY_PROVIDERS,
  RESERVED_LOGIN_PROVIDERS,
  ROOT_INVITE_CODE,
  ROOT_NICKNAME,
} from '../src/modules/users/identity.constants';
import { buildStage1, stage1Env } from './support/stage1-harness';

function context(authorization?: string) {
  const request: { header: (name: string) => string | undefined; user?: { id: bigint } } = {
    header: (name: string) => (name === 'authorization' ? authorization : undefined),
  };
  return {
    request,
    execution: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext,
  };
}

describe('mini program login and preview auth', () => {
  it('keeps the later login providers reserved and does not use them as the mini-program key', () => {
    expect(RESERVED_LOGIN_PROVIDERS).toEqual(['wechat_oa', 'wechat_web', 'sms_phone']);
    expect(IDENTITY_PROVIDERS.wechatMini).toBe('wechat_mini');
    expect(RESERVED_LOGIN_PROVIDERS).not.toContain(IDENTITY_PROVIDERS.wechatMini);
  });

  it('finds or creates a user by mini-program openid and does not merge on unionid', async () => {
    const { db, users, wechat, tokens } = buildStage1();
    wechat.logins.set('code-a', { openid: 'openid-a', unionid: 'union-1' });
    wechat.logins.set('code-b', { openid: 'openid-b', unionid: 'union-1' });

    const first = await users.loginWithMiniProgram('code-a');
    const again = await users.loginWithMiniProgram(' code-a ');
    expect(again.user.id).toBe(first.user.id);
    expect(again.user.member).toBe(false);
    expect(again.user.inviteCode).toBeNull();
    expect(again.tokenType).toBe('Bearer');
    await expect(tokens.verify(again.token)).resolves.toEqual({ sub: first.user.id });
    const wire = JSON.stringify(toJsonSafe(again.user));
    expect(wire).toContain(`"id":"${first.user.id.toString()}"`);

    const second = await users.loginWithMiniProgram('code-b');
    expect(second.user.id).not.toBe(first.user.id);
    expect(db.userIdentity.rows.filter((row) => row.unionId === 'union-1')).toHaveLength(2);
    expect(db.marketTreeNode.rows).toHaveLength(0);
    expect(db.userIdentity.rows.some((row) => row.provider === IDENTITY_PROVIDERS.smsPhone)).toBe(
      false,
    );
  });

  it('rejects a disabled user and does not issue a token', async () => {
    const { db, users, wechat, tokens, adminUsers } = buildStage1();
    wechat.logins.set('code-a', { openid: 'openid-a', unionid: null });
    const created = await users.loginWithMiniProgram('code-a');
    const guard = new MiniProgramTokenGuard(tokens, db as unknown as PrismaService);
    const allowed = context(`Bearer ${created.token}`);
    await expect(guard.canActivate(allowed.execution)).resolves.toBe(true);

    await adminUsers.disable(created.user.id);
    await expect(users.loginWithMiniProgram('code-a')).rejects.toThrow('账号已停用');
    expect(db.user.rows).toHaveLength(1);
    await expect(
      guard.canActivate(context(`Bearer ${created.token}`).execution),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await adminUsers.enable(created.user.id);
    const restored = await users.loginWithMiniProgram('code-a');
    expect(restored.user.id).toBe(created.user.id);
    expect(restored.user.status).toBe('active');
  });

  it('ignores preview login unless ALLOW_PREVIEW_AUTH is on', async () => {
    const env = stage1Env();
    const { db, users, wechat } = buildStage1(env);
    await expect(users.loginPreview('alice')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(users.loginPreview('not a valid subject')).rejects.toThrow('预览登录未启用');
    expect(db.user.rows).toHaveLength(0);
    expect(wechat.calls).toBe(0);

    env.allowPreviewAuth = true;
    const alice = await users.loginPreview('alice');
    const aliceAgain = await users.loginPreview('alice');
    const bob = await users.loginPreview('bob');
    expect(aliceAgain.user.id).toBe(alice.user.id);
    expect(bob.user.id).not.toBe(alice.user.id);
    expect(alice.user.member).toBe(false);
    expect(db.marketTreeNode.rows).toHaveLength(0);
    expect(db.userIdentity.rows.every((row) => row.provider === IDENTITY_PROVIDERS.preview)).toBe(
      true,
    );
  });

  it('binds a wechat phone onto the current user without merging accounts', async () => {
    const { db, users, wechat } = buildStage1();
    wechat.logins.set('code-a', { openid: 'openid-a', unionid: null });
    wechat.logins.set('code-b', { openid: 'openid-b', unionid: null });
    wechat.phones.set('phone-a', '13800138000');
    wechat.phones.set('phone-b', '13800138000');
    const first = await users.loginWithMiniProgram('code-a');
    const bound = await users.bindWechatPhone(first.user.id, 'phone-a');
    expect(bound.phone).toBe('13800138000');
    const second = await users.loginWithMiniProgram('code-b');
    await users.bindWechatPhone(second.user.id, 'phone-b');
    expect(second.user.id).not.toBe(first.user.id);
    expect(db.user.rows.filter((row) => row.phone === '13800138000')).toHaveLength(2);
    expect(db.userIdentity.rows.some((row) => row.provider === IDENTITY_PROVIDERS.smsPhone)).toBe(
      false,
    );
  });

  it('bootstraps only the root member, with both tree roots and the root invite code', async () => {
    const { db, users, wechat } = buildStage1();
    await users.onModuleInit();
    await users.onModuleInit();
    const roots = db.user.rows.filter((row) => row.inviteCode === ROOT_INVITE_CODE);
    expect(roots).toHaveLength(1);
    const root = roots[0];
    if (!root) {
      throw new Error('missing root');
    }
    expect(root.nickname).toBe(ROOT_NICKNAME);
    expect(root.status).toBe('active');
    expect(await users.isMember(root.id)).toBe(true);
    expect(db.inviteTreeNode.rows).toEqual([
      expect.objectContaining({
        userId: root.id,
        parentUserId: null,
        depth: 0,
        path: `/${root.id.toString()}/`,
      }),
    ]);
    expect(db.marketTreeNode.rows).toEqual([
      expect.objectContaining({
        userId: root.id,
        parentUserId: null,
        depth: 0,
      }),
    ]);

    wechat.logins.set('code-a', { openid: 'openid-a', unionid: null });
    const buyer = await users.loginWithMiniProgram('code-a');
    expect(buyer.user.member).toBe(false);
    expect(db.marketTreeNode.rows).toHaveLength(1);
    expect(db.user.rows.filter((row) => row.inviteCode === ROOT_INVITE_CODE)).toHaveLength(1);
  });
});
