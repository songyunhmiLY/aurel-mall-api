import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapException(exception);
    if (mapped.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(mapped.status).json({
      code: mapped.status,
      message: mapped.message,
      data: mapped.data,
    });
  }
}

function mapException(exception: unknown): { status: number; message: string; data: unknown } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const body = exception.getResponse();
    if (typeof body === 'string') {
      return { status, message: body, data: null };
    }
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;
      return {
        status,
        message: messageFromBody(record, exception.message),
        data: 'data' in record ? record.data : null,
      };
    }
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: '服务器内部错误', data: null };
}

function messageFromBody(record: Record<string, unknown>, fallback: string): string {
  const message = record.message;
  if (Array.isArray(message)) {
    return message.map(String).join('; ');
  }
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  return fallback;
}
