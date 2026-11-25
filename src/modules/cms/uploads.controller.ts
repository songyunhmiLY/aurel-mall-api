import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { parseRouteId } from '../../common/http/parse-id';
import { CmsService } from './cms.service';

/**
 * 富文本插图公开供图。不走登录：H5 与小程序的 <image> 直接按地址加载。
 * 地址形如 /api/v1/uploads/{id}，内容不可变，允许浏览器长期缓存。
 */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly cms: CmsService) {}

  @Get(':id')
  async show(@Param('id') id: string, @Res() res: Response): Promise<void> {
    let row;
    try {
      row = await this.cms.getImage(parseRouteId(id));
    } catch {
      throw new NotFoundException('图片不存在');
    }
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', row.sizeBytes.toString());
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.data);
  }
}
