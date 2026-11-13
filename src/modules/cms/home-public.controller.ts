import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MiniProgramTokenGuard } from '../../common/auth/mini-program-token.guard';
import { parsePage, parsePageSize, parseRouteId } from '../../common/http/parse-id';
import { CmsService } from './cms.service';

@Controller('home')
@UseGuards(MiniProgramTokenGuard)
export class HomePublicController {
  constructor(private readonly cms: CmsService) {}

  @Get('banners')
  banners() {
    return this.cms.listCurrentBanners();
  }

  @Get('tickers')
  tickers() {
    return this.cms.listCurrentTickers();
  }

  @Get('articles')
  articles(
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.cms.listCurrentArticles({
      kind: blankToUndefined(kind),
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  @Get('articles/:id')
  article(@Param('id') id: string) {
    return this.cms.getCurrentArticle(parseRouteId(id));
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}
