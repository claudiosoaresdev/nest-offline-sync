import { Module } from '@nestjs/common';
import { CatalogController } from 'src/modules/catalog/catalog.controller';
import { CatalogService } from 'src/modules/catalog/catalog.service';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
