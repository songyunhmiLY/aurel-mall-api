import { Controller, Get, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { CofounderEnrollmentService } from './cofounder-enrollment.service';

@Controller('me/cofounder')
@UseGuards(MiniProgramTokenGuard)
export class CofounderController {
  constructor(private readonly enrollment: CofounderEnrollmentService) {}

  @Get()
  page(@CurrentUser() user: UserPrincipal) {
    return this.enrollment.pageFor(user.id);
  }
}
