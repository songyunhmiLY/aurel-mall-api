import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import type { UserPrincipal } from '../../common/auth/user-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { CatalogService } from './catalog.service';

@Controller('catalog/products')
@UseGuards(MiniProgramTokenGuard)
export class CatalogPublicController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(
    @CurrentUser() user: UserPrincipal,
    @Query('zone') zone: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.catalog.listPublic(user.id, {
      zone,
      categoryId:
        categoryId === undefined || categoryId === '' ? undefined : parseRouteId(categoryId),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get(':id')
  detail(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    return this.catalog.getPublic(user.id, parseRouteId(id));
  }
}
