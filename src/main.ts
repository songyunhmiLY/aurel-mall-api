import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { ResponseInterceptor } from './common/http/response.interceptor';
import type { AppEnv } from './config/app-env';
import { APP_ENV } from './config/tokens';

loadDotenv();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');

  // 安全响应头。小程序与后台都不需要 CSP，关掉以免挡住内联样式。
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const env = app.get<AppEnv>(APP_ENV);
  applyCors(app, env);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(env.port, '0.0.0.0');
  logCorsState(env);
}

/**
 * 跨域只按白名单放行。
 * 没配 CORS_ORIGINS 就完全不开，等同于只接受同源请求——
 * 生产环境应由 nginx 把 /api 反代到本服务，浏览器看到的就是同源。
 */
function applyCors(app: INestApplication, env: AppEnv): void {
  if (env.corsOrigins.length === 0) {
    return;
  }
  app.enableCors({
    origin: env.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    maxAge: 600,
  });
}

function logCorsState(env: AppEnv): void {
  if (env.corsOrigins.length > 0) {
    console.log(`CORS 已启用，允许来源：${env.corsOrigins.join(', ')}`);
    return;
  }
  if (env.nodeEnv === 'production') {
    console.warn(
      'CORS 未启用。生产环境请用 nginx 把 /api 反代到本服务，或设置 CORS_ORIGINS 列出前端来源。',
    );
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
