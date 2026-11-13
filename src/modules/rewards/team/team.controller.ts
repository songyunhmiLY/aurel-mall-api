import { Controller, Get, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../../common/auth/user-principal';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { TeamService } from './team.service';

@Controller('me/team')
@UseGuards(MiniProgramTokenGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  get(@CurrentUser() user: UserPrincipal) {
    return this.team.getForUser(user.id);
  }
}
