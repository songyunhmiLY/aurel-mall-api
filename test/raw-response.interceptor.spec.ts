import { lastValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RawHttpBody } from '../src/common/http/raw-http-body';

describe('ResponseInterceptor', () => {
  it('wraps a normal payload', async () => {
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept({} as never, { handle: () => of({ ok: true }) }),
    );
    expect(result).toEqual({ code: 0, message: 'ok', data: { ok: true } });
  });

  it('returns a raw HTTP body without the api envelope', async () => {
    const status = jest.fn();
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(
        { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as never,
        { handle: () => of(new RawHttpBody(200, { code: 'SUCCESS', message: '成功' })) },
      ),
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(result).toEqual({ code: 'SUCCESS', message: '成功' });
  });
});
