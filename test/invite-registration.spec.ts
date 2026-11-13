import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { MiniLoginDto } from '../src/modules/users/dto/mini-login.dto';
import { PreviewLoginDto } from '../src/modules/users/dto/preview-login.dto';
import { ROOT_INVITE_CODE } from '../src/modules/users/identity.constants';
import { buildStage1, lockedConfig, stage1Env } from './support/stage1-harness';
import {
  addressOf,
  boot,
  buildStage2,
  credit,
  loginBuyer,
  marketNode,
  parentChain,
} from './support/stage2-harness';

describe('invite registration', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  it('rejects an invite code on mini and preview login', async () => {
    await expect(
      pipe.transform(
        { code: 'wx-code', inviteCode: ROOT_INVITE_CODE },
        {
          type: 'body',
          metatype: MiniLoginDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { subject: 'alice', inviteCode: ROOT_INVITE_CODE },
        {
          type: 'body',
          metatype: PreviewLoginDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a preview session bind the root code without creating a market seat', async () => {
    const stage = buildStage1(stage1Env({ allowPreviewAuth: true, locked: lockedConfig(1000) }));
    await stage.users.onModuleInit();
    const root = stage.db.user.rows.find((row) => row.inviteCode === ROOT_INVITE_CODE);
    if (!root) {
      throw new Error('missing root');
    }
    const session = await stage.users.loginPreview('alice');
    expect(session.user.inviteCode).toBeNull();
    expect(stage.db.inviteTreeNode.rows.some((row) => row.userId === session.user.id)).toBe(false);

    const bound = await stage.users.bindInviter(session.user.id, ROOT_INVITE_CODE);
    expect(bound.inviterId).toBe(root.id);
    expect(bound.inviteCode).toBe(ROOT_INVITE_CODE);
    const invite = stage.db.inviteTreeNode.rows.find((row) => row.userId === session.user.id);
    expect(invite?.parentUserId).toBe(root.id);
    expect(stage.db.marketTreeNode.rows.some((row) => row.userId === session.user.id)).toBe(false);
    expect(stage.db.user.rows.find((row) => row.id === session.user.id)?.member).toBe(false);
  });

  it('does not attach a user to the root when they never submit an invite code', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    expect(stage.db.user.rows.find((row) => row.id === rootId)?.inviteCode).toBe('000000');
    const buyer = await loginBuyer(stage, 'unbound', null);
    const again = await stage.users.loginWithMiniProgram('unbound');
    expect(again.user.inviteCode).toBeNull();
    expect(stage.db.inviteTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(0);

    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen: 0,
      stockQuantity: 2,
      status: 'on',
    });
    const addressId = await addressOf(stage, buyer);
    await expect(
      stage.orders.create(buyer, {
        zone: PRODUCT_ZONE_STARTUP,
        addressId,
        items: [{ productId: product.product.id, quantity: 1 }],
      }),
    ).rejects.toThrow('缺少邀请关系');
    expect(stage.db.inviteTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(0);
    expect(marketNode(stage.db, buyer)).toBeNull();
    expect(stage.db.inviteTreeNode.rows.filter((row) => row.parentUserId === rootId)).toHaveLength(
      0,
    );
  });

  it('binds under root or another member, then seats the buyer under that inviter', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const sponsor = await loginBuyer(stage, 'sponsor', null);
    expect(stage.db.user.rows.find((row) => row.id === sponsor)?.inviteCode).toBeNull();
    expect(stage.db.inviteTreeNode.rows.some((row) => row.userId === sponsor)).toBe(false);

    const underRoot = await stage.users.bindInviter(sponsor, '000000');
    expect(underRoot.inviteCode).toBe('000000');
    expect(underRoot.inviterId).toBe(rootId);
    expect(marketNode(stage.db, sponsor)).toBeNull();

    const product = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name: '创业装',
      freightFen: 0,
      stockQuantity: 4,
      status: 'on',
    });
    const sponsorAddress = await addressOf(stage, sponsor);
    await credit(stage, sponsor, 'points', 2000);
    const sponsorOrder = await stage.orders.create(sponsor, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId: sponsorAddress,
      items: [{ productId: product.product.id, quantity: 1 }],
    });
    await stage.orders.pay(sponsor, sponsorOrder.id);
    const sponsorCode = stage.db.user.rows.find((row) => row.id === sponsor)?.inviteCode;
    expect(sponsorCode).toMatch(/^\d{6}$/);
    expect(sponsorCode).not.toBe('000000');
    expect(marketNode(stage.db, sponsor)?.parentUserId).toBe(rootId);
    const sponsorInvite = stage.db.inviteTreeNode.rows.find((row) => row.userId === sponsor);
    expect(sponsorInvite?.parentUserId).toBe(rootId);

    const buyer = await loginBuyer(stage, 'buyer', null);
    const bound = await stage.users.bindInviter(buyer, String(sponsorCode));
    expect(bound.inviterId).toBe(sponsor);
    const buyerAddress = await addressOf(stage, buyer);
    await credit(stage, buyer, 'points', 2000);
    const buyerOrder = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId: buyerAddress,
      items: [{ productId: product.product.id, quantity: 1 }],
    });
    await stage.orders.pay(buyer, buyerOrder.id);
    expect(marketNode(stage.db, buyer)?.parentUserId).toBe(sponsor);
    expect(parentChain(stage.db, buyer)).toEqual([sponsor, rootId]);
    expect(stage.db.inviteTreeNode.rows.find((row) => row.userId === buyer)?.parentUserId).toBe(
      sponsor,
    );
    expect(stage.db.marketTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);
  });

  it('rejects unknown, non-member, disabled, already-bound, and self-invite codes', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'reject-buyer', null);
    await expect(stage.users.bindInviter(buyer, 'NOPE')).rejects.toThrow('邀请码不正确');
    await expect(stage.users.bindInviter(buyer, '999999')).rejects.toThrow('邀请码不正确');

    const plain = await loginBuyer(stage, 'plain', null);
    await stage.db.user.update({
      where: { id: plain },
      data: { inviteCode: '111111' },
    });
    await expect(stage.users.bindInviter(buyer, '111111')).rejects.toThrow('非会员不能作为邀请人');
    expect(stage.db.inviteTreeNode.rows.some((row) => row.userId === buyer)).toBe(false);

    await stage.db.user.update({
      where: { id: buyer },
      data: { inviteCode: '222222' },
    });
    await expect(stage.users.bindInviter(buyer, '222222')).rejects.toThrow('不能填写自己的邀请码');

    await stage.users.bindInviter(buyer, ROOT_INVITE_CODE);
    await expect(stage.users.bindInviter(buyer, ROOT_INVITE_CODE)).rejects.toThrow(
      '邀请关系已存在',
    );
    expect(stage.db.inviteTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);

    await stage.adminUsers.disable(rootId);
    const next = await loginBuyer(stage, 'after-disable', null);
    await expect(stage.users.bindInviter(next, ROOT_INVITE_CODE)).rejects.toThrow('邀请人已停用');
    expect(stage.db.user.rows.find((row) => row.id === rootId)?.inviteCode).toBe(ROOT_INVITE_CODE);
    expect(marketNode(stage.db, rootId)).not.toBeNull();
  });
});
