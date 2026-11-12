import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { isApiResponse, toJsonSafe } from './api-response';
import { RawHttpBody } from './raw-http-body';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data: unknown) => {
        if (data instanceof RawHttpBody) {
          const response = context.switchToHttp().getResponse<Response>();
          response.status(data.status);
          return data.value;
        }
        const body = isApiResponse(data) ? data : { code: 0, message: 'ok', data: data ?? null };
        return toJsonSafe(body);
      }),
    );
  }
}
