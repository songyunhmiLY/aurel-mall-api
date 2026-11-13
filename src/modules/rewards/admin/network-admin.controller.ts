import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../../common/auth/admin-jwt.guard';
import { parseRouteId } from '../../../common/http/parse-id';
import { NetworkAdminService } from './network-admin.service';

@Controller('admin/users')
@UseGuards(AdminJwtGuard)
export class NetworkAdminController {
  constructor(private readonly network: NetworkAdminService) {}

  @Get(':id/invite')
  invite(@Param('id') id: string) {
    return this.network.invite(parseRouteId(id));
  }

  @Get(':id/invite/ancestors')
  ancestors(@Param('id') id: string) {
    return this.network.ancestors(parseRouteId(id));
  }

  @Get(':id/invite/descendants')
  descendants(@Param('id') id: string, @Query('depth') depth?: string) {
    return this.network.descendants(parseRouteId(id), parseDepth(depth));
  }

  @Get(':id/market-tree')
  marketTree(@Param('id') id: string) {
    return this.network.marketTree(parseRouteId(id));
  }
}

function parseDepth(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 5;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException('层数不正确');
  }
  return Number(raw.trim());
}
