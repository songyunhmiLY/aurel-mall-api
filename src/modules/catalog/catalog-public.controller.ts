import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { CatalogService } from './catalog.service';

/**
 * 用户端商品接口。创业专区与会员商城在同一个商城里混排：
 * zone 不传或传 all 返回全部上架商品，传 startup / mall 只看一个专区。
 * 会员限制只在下单时校验，浏览对注册用户不设门槛。
 */
@Controller('catalog/products')
@UseGuards(MiniProgramTokenGuard)
export class CatalogPublicController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(
    @Query('zone') zone?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.catalog.listPublic({
      zone,
      categoryId:
        categoryId === undefined || categoryId === '' ? undefined : parseRouteId(categoryId),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.catalog.getPublic(parseRouteId(id));
  }
}
