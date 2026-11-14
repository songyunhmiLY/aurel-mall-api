import { isUserSeatConflict } from '../src/modules/rewards/trees/trees.service';
import {
  buildStage2,
  graftMarket,
  loginBuyer,
  marketNode,
  parentChain,
} from './support/stage2-harness';

describe('market seating', () => {
  function at(seconds: number): Date {
    return new Date(Date.UTC(2020, 0, 1, 0, 0, seconds));
  }

  async function seatUnder(stage: ReturnType<typeof buildStage2>, userId: bigint): Promise<void> {
    await stage.db.$transaction(async (tx) => {
      await stage.trees.seat(tx as never, userId, stage.clock.current);
    });
  }

  it('keeps the pre-seeded root seated and fills the inviter first level from the left', async () => {
    const stage = buildStage2();
    const rootId = await (async () => {
      await stage.users.onModuleInit();
      const root = stage.db.user.rows.find((row) => row.inviteCode === '000000');
      if (!root) {
        throw new Error('missing root');
      }
      expect(root.member).toBe(true);
      expect(root.seated).toBe(true);
      expect(marketNode(stage.db, root.id)?.parentUserId).toBeNull();
      return root.id;
    })();

    const first = await loginBuyer(stage, 'a', rootId);
    const second = await loginBuyer(stage, 'b', rootId);
    const third = await loginBuyer(stage, 'c', rootId);
    stage.clock.current = at(1);
    await seatUnder(stage, first);
    stage.clock.current = at(2);
    await seatUnder(stage, second);
    stage.clock.current = at(3);
    await seatUnder(stage, third);

    const children = stage.db.marketTreeNode.rows
      .filter((row) => row.parentUserId === rootId)
      .sort(
        (left, right) =>
          (left.placedAt as Date).getTime() - (right.placedAt as Date).getTime() ||
          (left.id < right.id ? -1 : 1),
      );
    expect(children.map((row) => row.userId)).toEqual([first, second, third]);
    expect(children.every((row) => row.depth === 1)).toBe(true);
    expect(marketNode(stage.db, first)).not.toHaveProperty('position');
  });

  it('prefers the same-level group with the most empty seats and breaks ties to the left', async () => {
    const stage = buildStage2();
    const rootId = await (async () => {
      await stage.users.onModuleInit();
      return stage.db.user.rows.find((row) => row.inviteCode === '000000')!.id;
    })();
    const left = 8101n;
    const middle = 8102n;
    const right = 8103n;
    graftMarket(stage.db, left, rootId, at(1));
    graftMarket(stage.db, middle, rootId, at(2));
    graftMarket(stage.db, right, rootId, at(3));
    graftMarket(stage.db, 8201n, left, at(11));
    graftMarket(stage.db, 8202n, left, at(12));
    graftMarket(stage.db, 8301n, right, at(13));

    const buyer = await loginBuyer(stage, 'most-empty', rootId);
    stage.clock.current = at(20);
    await seatUnder(stage, buyer);
    expect(marketNode(stage.db, buyer)?.parentUserId).toBe(middle);

    const tied = await loginBuyer(stage, 'tie-left', rootId);
    graftMarket(stage.db, 8401n, middle, at(21));
    graftMarket(stage.db, 8402n, middle, at(22));
    graftMarket(stage.db, 8403n, right, at(23));
    stage.clock.current = at(30);
    await seatUnder(stage, tied);
    expect(marketNode(stage.db, tied)?.parentUserId).toBe(left);
    const leftChildren = stage.db.marketTreeNode.rows
      .filter((row) => row.parentUserId === left)
      .sort(
        (a, b) => Number((a.placedAt as Date).getTime()) - Number((b.placedAt as Date).getTime()),
      );
    expect(leftChildren.map((row) => row.userId)).toEqual([8201n, 8202n, tied]);
  });

  it('searches the next level after the current level is full and stays inside the inviter subtree', async () => {
    const stage = buildStage2();
    await stage.users.onModuleInit();
    const rootId = stage.db.user.rows.find((row) => row.inviteCode === '000000')!.id;
    const level1 = [8301n, 8302n, 8303n];
    level1.forEach((id, index) => graftMarket(stage.db, id, rootId, at(index + 1)));
    const level2: bigint[] = [];
    for (const parent of level1) {
      for (let slot = 0; slot < 3; slot += 1) {
        const id = 8400n + BigInt(level2.length + 1);
        graftMarket(stage.db, id, parent, at(10 + level2.length));
        level2.push(id);
      }
    }
    const deep = await loginBuyer(stage, 'deep', rootId);
    stage.clock.current = at(40);
    await seatUnder(stage, deep);
    expect(marketNode(stage.db, deep)?.parentUserId).toBe(level2[0]);
    expect(marketNode(stage.db, deep)?.depth).toBe(3);
    expect(parentChain(stage.db, deep)).toContain(rootId);

    const inviter = 8500n;
    graftMarket(stage.db, inviter, rootId, at(50));
    const direct = await loginBuyer(stage, 'under-inviter', inviter);
    stage.clock.current = at(51);
    await seatUnder(stage, direct);
    expect(marketNode(stage.db, direct)?.parentUserId).toBe(inviter);
    expect(parentChain(stage.db, direct)[0]).toBe(inviter);

    const fullInviter = 8700n;
    graftMarket(stage.db, fullInviter, rootId, at(52));
    for (let slot = 0; slot < 3; slot += 1) {
      graftMarket(stage.db, 8600n + BigInt(slot), fullInviter, at(60 + slot));
    }
    const nested = await loginBuyer(stage, 'nested', fullInviter);
    stage.clock.current = at(70);
    await seatUnder(stage, nested);
    expect(marketNode(stage.db, nested)?.parentUserId).toBe(8600n);
    expect(parentChain(stage.db, nested)).toEqual([8600n, fullInviter, rootId]);
    expect(marketNode(stage.db, nested)?.parentUserId).not.toBe(rootId);
  });

  it('keeps the first seat when the same user pays the startup zone again', async () => {
    const stage = buildStage2();
    await stage.users.onModuleInit();
    const rootId = stage.db.user.rows.find((row) => row.inviteCode === '000000')!.id;
    const buyer = await loginBuyer(stage, 'repeat', rootId);

    stage.clock.current = at(1);
    await seatUnder(stage, buyer);
    const first = marketNode(stage.db, buyer);
    expect(first?.parentUserId).toBe(rootId);
    expect(first?.slot).toBe(1);

    // 把上级剩下两个位置占满，再让同一个人支付一次创业专区。
    graftMarket(stage.db, 8801n, rootId, at(10));
    graftMarket(stage.db, 8802n, rootId, at(11));
    stage.clock.current = at(20);
    await seatUnder(stage, buyer);

    const after = marketNode(stage.db, buyer);
    expect(after?.id).toBe(first?.id);
    expect(after?.parentUserId).toBe(rootId);
    expect(after?.slot).toBe(1);
    expect(after?.depth).toBe(first?.depth);
    expect(stage.db.marketTreeNode.rows.filter((row) => row.userId === buyer)).toHaveLength(1);
  });
});

describe('seat conflict routing', () => {
  it('reads the user unique index as already seated and the slot index as retry', () => {
    expect(isUserSeatConflict({ code: 'P2002', meta: { target: 'market_tree_user_id_uq' } })).toBe(
      true,
    );
    expect(isUserSeatConflict({ code: 'P2002', meta: { target: ['user_id'] } })).toBe(true);
    expect(
      isUserSeatConflict({ code: 'P2002', meta: { target: 'market_tree_parent_slot_uq' } }),
    ).toBe(false);
    expect(
      isUserSeatConflict({ code: 'P2002', meta: { target: ['parent_user_id', 'slot'] } }),
    ).toBe(false);
    expect(isUserSeatConflict({ code: 'P2002', meta: {} })).toBe(false);
    expect(isUserSeatConflict(new Error('boom'))).toBe(false);
  });
});
