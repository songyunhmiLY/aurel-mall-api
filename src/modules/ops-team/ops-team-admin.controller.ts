import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import type { AdminPrincipal } from '../../common/auth/admin-principal';
import { CurrentAdmin } from '../../common/auth/current-admin.decorator';
import { parseRouteId } from '../../common/http/parse-id';
import { AppointOpsTeamDto } from './dto/appoint-ops-team.dto';
import { OpsTeamEnrollmentService } from './ops-team-enrollment.service';

/**
 * 运营团队只有管理员可以指定、改派和取消。
 * 比例在启动时锁定，这里没有设置接口。
 */
@Controller('admin/ops-team')
@UseGuards(AdminJwtGuard)
export class OpsTeamAdminController {
  constructor(private readonly enrollment: OpsTeamEnrollmentService) {}

  @Get()
  current() {
    return this.enrollment.current();
  }

  @Post()
  @HttpCode(200)
  appoint(@CurrentAdmin() admin: AdminPrincipal, @Body() body: AppointOpsTeamDto) {
    return this.enrollment.appoint(parseRouteId(body.userId), admin.id);
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(@CurrentAdmin() admin: AdminPrincipal) {
    return this.enrollment.cancel(admin.id);
  }
}
