import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from 'src/modules/idempotency/idempotency.interceptor';
import { IdempotencyService } from 'src/modules/idempotency/idempotency.service';

@Module({
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
