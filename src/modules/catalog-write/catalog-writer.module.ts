import { Module } from '@nestjs/common';
import { CatalogWriterController } from 'src/modules/catalog-write/catalog-writer.controller';
import { CatalogWriterService } from 'src/modules/catalog-write/catalog-writer.service';
import { IdempotencyModule } from 'src/modules/idempotency/idempotency.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';

@Module({
  imports: [IdempotencyModule, NotificationsModule],
  controllers: [CatalogWriterController],
  providers: [CatalogWriterService],
  exports: [CatalogWriterService],
})
export class CatalogWriteModule {}
