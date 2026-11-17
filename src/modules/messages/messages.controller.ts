import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { MessagesService } from './messages.service';

/**
 * 小程序站内消息。只要求登录，不检查会员身份。
 * 红点读 unread，进入列表后调 read 把上次查看时间推到当前。
 */
@Controller('messages')
@UseGuards(MiniProgramTokenGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(
    @CurrentUser() user: UserPrincipal,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.messages.listForUser(user.id, {
      category: category === undefined || category.trim() === '' ? undefined : category.trim(),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('unread')
  unread(@CurrentUser() user: UserPrincipal) {
    return this.messages.unreadCount(user.id);
  }

  @Post('read')
  @HttpCode(200)
  read(@CurrentUser() user: UserPrincipal) {
    return this.messages.markRead(user.id);
  }

  @Get(':id')
  detail(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.messages.getForUser(user.id, parseRouteId(id));
  }
}
