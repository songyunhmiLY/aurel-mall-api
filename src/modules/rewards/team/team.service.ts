import { Injectable } from '@nestjs/common';
import { ClockService } from '../../../common/clock/clock.service';
import {
  nextBizMonth,
  shanghaiBizMonth,
  startOfBizMonth,
  startOfNextShanghaiDay,
  startOfRecentShanghaiDays,
  startOfShanghaiDay,
} from '../../../common/clock/shanghai-calendar';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketPerformanceService } from '../market-performance.service';

export interface TeamMarketView {
  name: string;
  monthPerformanceFen: bigint;
  recent7DaysPerformanceFen: bigint;
  todayPerformanceFen: bigint;
}

export interface TeamView {
  marketCount: number;
  totalPerformanceFen: bigint;
  markets: TeamMarketView[];
}

/**
 * 创业团队页。市场是一名直接下级加上该下级下面的所有人，最多三个。
 * 业绩是这些人所在范围内、创业专区已支付订单的应付金额，单位分，含运费。
 * 近 7 日是含今天在内的 7 个上海自然日。
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly performance: MarketPerformanceService,
  ) {}

  async getForUser(userId: bigint): Promise<TeamView> {
    const now = await this.clock.now();
    const nodes = await this.performance.loadNodes();
    const markets = this.performance.directChildren(nodes, userId);
    const monthStart = startOfBizMonth(shanghaiBizMonth(now));
    const monthEnd = startOfBizMonth(nextBizMonth(shanghaiBizMonth(now)));
    const todayStart = startOfShanghaiDay(now);
    const tomorrow = startOfNextShanghaiDay(now);
    const recentStart = startOfRecentShanghaiDays(now, 7);
    const userIds = markets.flatMap((market) => this.performance.subtreeUserIds(nodes, market));
    const uniqueIds = [...new Map(userIds.map((id) => [id.toString(), id])).values()];
    const marketUserIds = markets.map((market) => market.userId);
    const [monthAmounts, recentAmounts, todayAmounts, users] = await Promise.all([
      this.performance.startupPaidByUser(uniqueIds, monthStart, monthEnd),
      this.performance.startupPaidByUser(uniqueIds, recentStart, tomorrow),
      this.performance.startupPaidByUser(uniqueIds, todayStart, tomorrow),
      marketUserIds.length === 0
        ? Promise.resolve([])
        : this.prisma.user.findMany({ where: { id: { in: marketUserIds } } }),
    ]);
    const names = new Map(users.map((user) => [user.id.toString(), displayName(user.nickname)]));
    let total = 0n;
    const views = markets.map((market) => {
      const ids = this.performance.subtreeUserIds(nodes, market);
      const monthPerformanceFen = this.performance.sumUsers(monthAmounts, ids);
      total += monthPerformanceFen;
      return {
        name: names.get(market.userId.toString()) ?? '会员',
        monthPerformanceFen,
        recent7DaysPerformanceFen: this.performance.sumUsers(recentAmounts, ids),
        todayPerformanceFen: this.performance.sumUsers(todayAmounts, ids),
      };
    });
    return { marketCount: views.length, totalPerformanceFen: total, markets: views };
  }
}

function displayName(nickname: string): string {
  const trimmed = nickname.trim();
  return trimmed.length > 0 ? trimmed : '会员';
}
