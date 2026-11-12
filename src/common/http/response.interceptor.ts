import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { isApiResponse, toJsonSafe } from './api-response';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data: unknown) => {
        const body = isApiResponse(data) ? data : { code: 0, message: 'ok', data: data ?? null };
        return toJsonSafe(body);
      }),
    );
  }
}
