import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Offline Sync API')
    .setDescription('Catalog snapshot + delta sync')
    .setVersion('1.0')
    .build();

  const openApiDoc = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(
    'docs',
    app,
    cleanupOpenApiDoc(openApiDoc, { version: 'auto' }),
  );

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key', // ✅ necessário
      'idempotency-key', // ✅ alguns runtimes normalizam para lowercase
      'Last-Event-ID', // ✅ útil p/ SSE reconnect
      'last-event-id', // ✅ idem
    ],
  });

  const configService = app.get(ConfigService<Env, true>);
  const port = configService.get('PORT', { infer: true });

  await app.listen(port);
}

void bootstrap();
