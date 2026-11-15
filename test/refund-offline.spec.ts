import { GoneException } from '@nestjs/common';
import { AdminRefundsController } from '../src/modules/orders/admin-refunds.controller';
import { AdminSettlementCompensationsController } from '../src/modules/orders/admin-settlement-compensations.controller';
import { RefundsController } from '../src/modules/orders/refunds.controller';
import type { RefundsService } from '../src/modules/orders/refunds.service';
import type { SettlementCompensationService } from '../src/modules/orders/settlement-compensation.service';

/**
 * 退款能力下线后的接口契约：只保留只读历史，全部写动作与客户端接口返回 410。
 * 业务实现（RefundsService）保留，所以这里只断言路由层行为。
 */
describe('退款能力下线', () => {
  function expectGone(call: () => unknown): void {
    expect(call).toThrow(GoneException);
    try {
      call();
    } catch (error) {
      expect((error as GoneException).getStatus()).toBe(410);
    }
  }

  it('小程序端三个退款接口一律 410', () => {
    const controller = new RefundsController();
    expectGone(() => controller.apply());
    expectGone(() => controller.list());
    expectGone(() => controller.detail());
  });

  it('管理端审核动作 410，但列表仍可读历史', async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    const refunds = { listAdmin: async () => page } as unknown as RefundsService;
    const controller = new AdminRefundsController(refunds);

    expectGone(() => controller.approve());
    expectGone(() => controller.reject());
    await expect(controller.list()).resolves.toEqual(page);
  });

  it('补偿转退款 410，继续结算不受影响', () => {
    const compensations = {} as SettlementCompensationService;
    const controller = new AdminSettlementCompensationsController(compensations);
    expectGone(() => controller.refund());
  });
});
