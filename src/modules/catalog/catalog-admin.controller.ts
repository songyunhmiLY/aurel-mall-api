import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import {
  parseOptionalId,
  parsePage,
  parsePageSize,
  parseRouteId,
} from '../../common/http/parse-id';
import { CatalogService } from './catalog.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { SetHomeVisibleDto, SetSortDto } from './dto/product-flags.dto';
import { SetStockDto } from './dto/set-stock.dto';
import { ShelfProductDto } from './dto/shelf-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Controller('admin')
@UseGuards(AdminJwtGuard)
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  list(
    @Query('zone') zone?: string,
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.catalog.listAdmin({
      zone: zone === undefined || zone === '' ? undefined : zone,
      status: status === undefined || status === '' ? undefined : status,
      categoryId:
        categoryId === undefined || categoryId === '' ? undefined : parseRouteId(categoryId),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('products/:id')
  detail(@Param('id') id: string) {
    return this.catalog.getAdmin(parseRouteId(id));
  }

  @Post('products')
  @HttpCode(200)
  create(@Body() body: CreateProductDto) {
    return this.catalog.create({
      ...body,
      categoryId: parseOptionalId(body.categoryId),
    });
  }

  @Put('products/:id')
  update(@Param('id') id: string, @Body() body: UpdateProductDto) {
    return this.catalog.update(parseRouteId(id), {
      ...body,
      categoryId: parseOptionalId(body.categoryId),
    });
  }

  @Post('products/:id/shelf')
  @HttpCode(200)
  shelf(@Param('id') id: string, @Body() body: ShelfProductDto) {
    return this.catalog.setShelf(parseRouteId(id), body.status);
  }

  @Put('products/:id/stock')
  setStock(@Param('id') id: string, @Body() body: SetStockDto) {
    return this.catalog.setStock(parseRouteId(id), body.quantity);
  }

  @Put('products/:id/sort')
  setSort(@Param('id') id: string, @Body() body: SetSortDto) {
    return this.catalog.setSort(parseRouteId(id), body.sortOrder);
  }

  @Put('products/:id/home')
  setHomeVisible(@Param('id') id: string, @Body() body: SetHomeVisibleDto) {
    return this.catalog.setHomeVisible(parseRouteId(id), body.homeVisible);
  }

  @Get('mall-categories')
  listCategories() {
    return this.catalog.listCategories();
  }

  @Post('mall-categories')
  @HttpCode(200)
  createCategory(@Body() body: CreateCategoryDto) {
    return this.catalog.createCategory(body);
  }

  @Put('mall-categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: UpdateCategoryDto) {
    return this.catalog.updateCategory(parseRouteId(id), body);
  }
}
