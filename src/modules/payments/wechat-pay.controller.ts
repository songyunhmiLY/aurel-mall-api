import { Body, Controller, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RawHttpBody } from '../../common/http/raw-http-body';
import { CreateWechatPrepayDto } from './dto/create-wechat-prepay.dto';
import { SandboxSucceedDto } from './dto/sandbox-succeed.dto';
import { WechatPayService } from './wechat-pay.service';

type RequestWithRawBody = Request & { rawBody?: Buffer };

@Controller('payments/wechat')
export class WechatPayController {
  constructor(private readonly payments: WechatPayService) {}

  @Post('prepay')
  @HttpCode(200)
  prepay(@Body() body: CreateWechatPrepayDto) {
    return this.payments.createPrepay(body);
  }

  @Post('sandbox/succeed')
  @HttpCode(200)
  sandboxSucceed(@Body() body: SandboxSucceedDto) {
    return this.payments.simulateSuccess(body.payNo);
  }

  @Post('notify')
  async notify(@Req() req: RequestWithRawBody): Promise<RawHttpBody> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!raw) {
      return new RawHttpBody(400, { code: 'FAIL', message: '缺少原始报文' });
    }
    try {
      await this.payments.handleNotify(raw, {
        timestamp: req.header('wechatpay-timestamp') ?? '',
        nonce: req.header('wechatpay-nonce') ?? '',
        signature: req.header('wechatpay-signature') ?? '',
        serial: req.header('wechatpay-serial') ?? '',
      });
      return new RawHttpBody(200, { code: 'SUCCESS', message: '成功' });
    } catch (error) {
      const status = error instanceof HttpException && error.getStatus() < 500 ? 400 : 500;
      return new RawHttpBody(status, { code: 'FAIL', message: httpExceptionMessage(error) });
    }
  }
}

function httpExceptionMessage(error: unknown): string {
  if (!(error instanceof HttpException)) {
    return '处理失败';
  }
  const body = error.getResponse();
  if (typeof body === 'string' && body.length > 0) {
    return body;
  }
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (Array.isArray(message)) {
      return message.map(String).join('; ');
    }
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return '处理失败';
}
