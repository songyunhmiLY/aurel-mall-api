import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminJwtGuard } from '../../common/auth/admin-jwt.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { CMS_IMAGE_MAX_BYTES } from './cms.constants';
import { CmsService } from './cms.service';
import { ArticleStatusDto, CreateArticleDto, UpdateArticleDto } from './dto/article.dto';
import { BannerStatusDto, CreateBannerDto, UpdateBannerDto } from './dto/banner.dto';
import { CreateTickerDto, TickerStatusDto, UpdateTickerDto } from './dto/ticker.dto';

@Controller('admin/home')
@UseGuards(AdminJwtGuard)
export class HomeAdminController {
  constructor(private readonly cms: CmsService) {}

  @Get('banners')
  listBanners(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.cms.listAdminBanners({
      status: blankToUndefined(status),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('banners/:id')
  getBanner(@Param('id') id: string) {
    return this.cms.getAdminBanner(parseRouteId(id));
  }

  @Post('banners')
  @HttpCode(200)
  createBanner(@Body() body: CreateBannerDto) {
    return this.cms.createBanner(body);
  }

  @Put('banners/:id')
  updateBanner(@Param('id') id: string, @Body() body: UpdateBannerDto) {
    return this.cms.updateBanner(parseRouteId(id), body);
  }

  @Post('banners/:id/status')
  @HttpCode(200)
  setBannerStatus(@Param('id') id: string, @Body() body: BannerStatusDto) {
    return this.cms.setBannerStatus(parseRouteId(id), body.status);
  }

  @Get('tickers')
  listTickers(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.cms.listAdminTickers({
      status: blankToUndefined(status),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('tickers/:id')
  getTicker(@Param('id') id: string) {
    return this.cms.getAdminTicker(parseRouteId(id));
  }

  @Post('tickers')
  @HttpCode(200)
  createTicker(@Body() body: CreateTickerDto) {
    return this.cms.createTicker(body);
  }

  @Put('tickers/:id')
  updateTicker(@Param('id') id: string, @Body() body: UpdateTickerDto) {
    return this.cms.updateTicker(parseRouteId(id), body);
  }

  @Post('tickers/:id/status')
  @HttpCode(200)
  setTickerStatus(@Param('id') id: string, @Body() body: TickerStatusDto) {
    return this.cms.setTickerStatus(parseRouteId(id), body.status);
  }

  @Get('articles')
  listArticles(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.cms.listAdminArticles({
      kind: blankToUndefined(kind),
      status: blankToUndefined(status),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('articles/:id')
  getArticle(@Param('id') id: string) {
    return this.cms.getAdminArticle(parseRouteId(id));
  }

  @Post('articles')
  @HttpCode(200)
  createArticle(@Body() body: CreateArticleDto) {
    return this.cms.createArticle(body);
  }

  @Put('articles/:id')
  updateArticle(@Param('id') id: string, @Body() body: UpdateArticleDto) {
    return this.cms.updateArticle(parseRouteId(id), body);
  }

  @Post('articles/:id/status')
  @HttpCode(200)
  setArticleStatus(@Param('id') id: string, @Body() body: ArticleStatusDto) {
    return this.cms.setArticleStatus(parseRouteId(id), body.status);
  }

  /** 富文本插图上传，multipart 字段名是 file。 */
  @Post('images')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: CMS_IMAGE_MAX_BYTES, files: 1 },
    }),
  )
  uploadImage(@UploadedFile() file?: { mimetype: string; size: number; buffer: Buffer }) {
    return this.cms.uploadImage(file ?? { mimetype: '', size: 0, buffer: Buffer.alloc(0) });
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}
