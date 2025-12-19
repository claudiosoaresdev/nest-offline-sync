import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { envSchema } from 'src/config/env.schema';
import { PrismaModule } from 'src/infra/database/prisma.module';
import { CatalogModule } from 'src/modules/catalog/catalog.module';
import { CatalogWriteModule } from 'src/modules/catalog-write/catalog-writer.module';
import { EventsModule } from 'src/modules/events/events.module';
import { IdempotencyModule } from 'src/modules/idempotency/idempotency.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { OrdersModule } from 'src/modules/orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      validate: (env) => envSchema.parse(env),
      isGlobal: true,
    }),
    PrismaModule,
    CatalogModule,
    CatalogWriteModule,
    OrdersModule,
    IdempotencyModule,
    EventsModule,
    NotificationsModule,
  ],
  controllers: [],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
