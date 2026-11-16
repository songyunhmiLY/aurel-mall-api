import { PRODUCT_ZONE_STARTUP } from '../src/modules/catalog/catalog.constants';
import { FinanceService } from '../src/modules/finance/finance.service';
import {
  addressOf,
  boot,
  buildStage2,
  loginBuyer,
  type Stage2,
} from './support/stage2-harness';

/** MutableClock 没有上海自然日方法，补一个等效实现供 FinanceService 使用。 */
function financeClock(stage: Stage2) {
  const base = stage.clock;
  return {
    now: () => base.now(),
    instant: (ms: number) => base.instant(ms),
    startOfDay: (day: Date) =>
      Promise.resolve(
        new Date(
          Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), -8),
        ),
      ),
    startOfMonth: (day: Date) =>
      Promise.resolve(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1, -8))),
  };
}

describe('product cost and sku sales summary', () => {
  async function startupProduct(
    stage: Stage2,
    name: string,
    stock: number,
    costFen?: number | null,
  ) {
    const created = await stage.catalog.create({
      zone: PRODUCT_ZONE_STARTUP,
      name,
      freightFen: 0,
      costFen,
      stockQuantity: stock,
      status: 'on',
    });
    return created.product;
  }

  it('snapshots unit cost on order items and aggregates sku sales by status', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'cost-buyer', rootId);
    const addressId = await addressOf(stage, buyer);
    const withCost = await startupProduct(stage, '有成本', 5, 400);
    const noCost = await startupProduct(stage, '无成本', 5);

    expect(withCost.costFen).toBe(400);
    expect(noCost.costFen).toBeNull();

    const first = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: withCost.id, quantity: 2 }],
    });
    const firstPay = await stage.orders.pay(buyer, first.id);
    await stage.wechatPay.simulateSuccess(firstPay.wechat!.payNo);

    const second = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: noCost.id, quantity: 1 }],
    });
    const secondPay = await stage.orders.pay(buyer, second.id);
    await stage.wechatPay.simulateSuccess(secondPay.wechat!.payNo);
    await stage.orders.ship(second.id, {
      courierName: '顺丰',
      trackingNumber: 'SF0000000001',
    });

    const orderItemRows = stage.db.orderItem.rows.filter((row) => row.skuId === withCost.skuId);
    expect(orderItemRows).toHaveLength(1);
    expect(orderItemRows[0]).toMatchObject({ unitCostFen: 400, quantity: 2 });

    const finance = new FinanceService(
      stage.db as unknown as ConstructorParameters<typeof FinanceService>[0],
      financeClock(stage) as unknown as ConstructorParameters<typeof FinanceService>[1],
    );
    const summary = await finance.skuSales({
      from: '2026-11-01',
      to: '2026-12-01',
      page: 1,
      pageSize: 20,
      zone: 'startup',
    });
    expect(summary.rows).toHaveLength(2);

    const withCostRow = summary.rows.find((row) => row.skuId === withCost.skuId.toString());
    expect(withCostRow).toMatchObject({
      quantity: 2,
      salesAmountFen: '2000',
      pendingQuantity: 2,
      pendingAmountFen: '2000',
      shippedQuantity: 0,
      shippedAmountFen: '0',
      costAmountFen: '800',
      profitFen: '1200',
    });

    const noCostRow = summary.rows.find((row) => row.skuId === noCost.skuId.toString());
    expect(noCostRow).toMatchObject({
      quantity: 1,
      salesAmountFen: '1000',
      shippedQuantity: 1,
      shippedAmountFen: '1000',
      pendingQuantity: 0,
      costAmountFen: '0',
      profitFen: '1000',
    });

    // 库存不参与结算，留档数量不变
    expect(stage.db.skuStock.rows.find((row) => row.skuId === withCost.skuId)?.quantity).toBe(5);
  });

  it('keeps cost optional and defaults profit to full sales when cost is unset', async () => {
    const stage = buildStage2();
    const rootId = await boot(stage);
    const buyer = await loginBuyer(stage, 'cost-optional', rootId);
    const addressId = await addressOf(stage, buyer);
    const product = await startupProduct(stage, '补录成本', 5, null);

    const created = await stage.orders.create(buyer, {
      zone: PRODUCT_ZONE_STARTUP,
      addressId,
      items: [{ productId: product.id, quantity: 1 }],
    });
    const createdPay = await stage.orders.pay(buyer, created.id);
    await stage.wechatPay.simulateSuccess(createdPay.wechat!.payNo);

    // 事后补录成本：只影响后续订单的快照，历史订单行保持为空
    await stage.catalog.update(product.id, { costFen: 300 });
    expect((await stage.catalog.getAdmin(product.id)).costFen).toBe(300);

    const finance = new FinanceService(
      stage.db as unknown as ConstructorParameters<typeof FinanceService>[0],
      financeClock(stage) as unknown as ConstructorParameters<typeof FinanceService>[1],
    );
    const summary = await finance.skuSales({
      from: '2026-11-01',
      to: '2026-12-01',
      page: 1,
      pageSize: 20,
    });
    const row = summary.rows.find((item) => item.skuId === product.skuId.toString());
    expect(row).toMatchObject({
      quantity: 1,
      salesAmountFen: '1000',
      costAmountFen: '0',
      profitFen: '1000',
    });
  });
});
