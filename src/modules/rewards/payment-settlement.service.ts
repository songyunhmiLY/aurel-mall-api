import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { enqueueNotify } from '../../common/notify/notify-buffer';
import { PRODUCT_ZONE_STARTUP } from '../catalog/catalog.constants';
import { CofounderDividendService } from '../cofounder/cofounder-dividend.service';
import { MESSAGE_CATEGORY_ORDER } from '../messages/message.constants';
import { MessagesService, orderMessageLink, yuanText } from '../messages/messages.service';
import { OpsTeamDividendService } from '../ops-team/ops-team-dividend.service';
import { StudioSubsidyService } from '../studio/studio-subsidy.service';
import { AwardService } from './award.service';
import { FilingService } from './filing/filing.service';

type Tx = Prisma.TransactionClient;

/**
 * 支付成功事务里的报单和奖励。入座已经在调用前完成。
 * 重复调用不会重复入账：子单、当日报单和奖励业务号都有去重。
 */
@Injectable()
export class PaymentSettlementService {
  constructor(
    private readonly filing: FilingService,
    private readonly awards: AwardService,
    private readonly cofounders: CofounderDividendService,
    private readonly studios: StudioSubsidyService,
    private readonly opsTeam: OpsTeamDividendService,
    private readonly messages: MessagesService,
  ) {}

  async afterOrderPaid(event: {
    tx: Tx;
    orderId: bigint;
    userId: bigint;
    zone: string;
    payAmountFen: number;
    pvFen: number;
    paidAt: Date;
  }): Promise<void> {
    const order = await event.tx.order.findUnique({ where: { id: event.orderId } });
    if (!order) {
      return;
    }
    await this.messages.record(
      event.tx,
      {
        userId: order.userId,
        category: MESSAGE_CATEGORY_ORDER,
        title: '支付成功',
        body: `订单 ${order.orderNo} 已支付成功，实付 ${yuanText(event.payAmountFen)}。`,
        linkPage: orderMessageLink(order.id),
        bizType: 'order',
        bizId: order.id.toString(),
      },
      event.paidAt,
    );
    await this.notifyPaid(event, order.orderNo);
    if (order.zone === PRODUCT_ZONE_STARTUP) {
      await this.filing.onStartupPaid(
        event.tx,
        { id: order.id, userId: order.userId, placedAt: order.placedAt },
        event.paidAt,
      );
    }
    await this.awards.grantForPaidOrder(
      event.tx,
      {
        id: order.id,
        userId: order.userId,
        zone: order.zone,
        goodsTotalFen: order.goodsTotalFen,
        pvFen: order.pvFen,
      },
      event.paidAt,
    );
    await this.cofounders.onPaidOrder(
      event.tx,
      {
        id: order.id,
        userId: order.userId,
        zone: order.zone,
        goodsTotalFen: order.goodsTotalFen,
        pvFen: order.pvFen,
      },
      event.paidAt,
    );
    await this.studios.onPaidOrder(
      event.tx,
      {
        id: order.id,
        userId: order.userId,
        zone: order.zone,
        goodsTotalFen: order.goodsTotalFen,
        pvFen: order.pvFen,
      },
      event.paidAt,
    );
    await this.opsTeam.onPaidOrder(
      event.tx,
      {
        id: order.id,
        userId: order.userId,
        zone: order.zone,
        goodsTotalFen: order.goodsTotalFen,
        pvFen: order.pvFen,
      },
      event.paidAt,
    );
  }

  /**
   * 订单支付成功的订阅消息。只在事务里入队，提交后才发。
   * 商品名取第一件，多件时带总件数，模板空位放得下。
   */
  private async notifyPaid(
    event: { tx: Tx; orderId: bigint; userId: bigint; payAmountFen: number; paidAt: Date },
    orderNo: string,
  ): Promise<void> {
    const items = await event.tx.orderItem.findMany({
      where: { orderId: event.orderId },
      orderBy: { id: 'asc' },
    });
    let totalQuantity = 0;
    for (const item of items) {
      totalQuantity += item.quantity;
    }
    enqueueNotify({
      type: 'order_paid',
      userId: event.userId,
      orderNo,
      amountFen: BigInt(event.payAmountFen),
      goodsName: goodsNameText(items[0]?.productName ?? '', totalQuantity),
      occurredAt: event.paidAt,
    });
  }
}

/** 微信模板的商品名称空位一般只有 20 个字，超了截断并加省略号。 */
const GOODS_NAME_MAX = 20;

function goodsNameText(firstName: string, totalQuantity: number): string {
  const name = firstName || '订单商品';
  const text = totalQuantity > 1 ? `${name} 等 ${totalQuantity} 件` : name;
  return text.length > GOODS_NAME_MAX ? `${text.slice(0, GOODS_NAME_MAX - 1)}…` : text;
}
