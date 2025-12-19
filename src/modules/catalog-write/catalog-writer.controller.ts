import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { ZodValidationPipe } from 'src/common/pipes/zod-validation.pipe';
import { CatalogWriterService } from 'src/modules/catalog-write/catalog-writer.service';
import { EmitChangeResultDto } from 'src/modules/catalog-write/dto/emit-change-result.schema';
import {
  UpsertProductInputDto,
  UpsertProductInputSchema,
} from 'src/modules/catalog-write/dto/upsert-product.input.schema';
import { IdempotencyInterceptor } from 'src/modules/idempotency/idempotency.interceptor';
import { Idempotent } from 'src/modules/idempotency/idempotent.decorator';
import { z } from 'zod';

// Pipes (validação de entrada)
const upsertBodyPipe = new ZodValidationPipe(UpsertProductInputSchema);
const uuidParamPipe = new ZodValidationPipe(z.uuid());

/**
 * Endpoints ADMIN para testar o delta sync “de verdade”.
 *
 * Importante:
 * - Esses endpoints NÃO são parte do app final do cliente.
 * - Eles existem para você simular uma fonte de dados (ERP/admin/job)
 *   alterando produtos, e então validar o comportamento de:
 *   GET /catalog/changes?sinceVersion=...
 */
@Controller('catalog/products')
@UseGuards(AdminGuard)
export class CatalogWriterController {
  constructor(private readonly writer: CatalogWriterService) {}

  /**
   * POST /catalog/products/upsert
   *
   * Exemplo:
   * curl -X POST http://localhost:3001/catalog/products/upsert \
   *  -H "Content-Type: application/json" \
   *  -d '{"sku":"SKU-000001","name":"Produto X","priceCents":12990,"stockOnHand":10}'
   *
   * Resultado:
   * - Persiste Product + Price + Inventory
   * - Emite ProductChange(UPSERT)
   * - Atualiza CatalogState.currentVersion
   *
   * Depois disso, você consegue ver a mudança com:
   * GET /catalog/changes?sinceVersion=<suaVersaoAnterior>
   */
  @Post('upsert')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBody({ type: UpsertProductInputDto })
  @ZodResponse({ type: EmitChangeResultDto })
  upsert(
    @Body(upsertBodyPipe) body: UpsertProductInputDto,
  ): Promise<EmitChangeResultDto> {
    return this.writer.upsertProductAndEmitChange(body);
  }

  /**
   * DELETE /catalog/products/:id
   *
   * Exemplo:
   * curl -X DELETE http://localhost:3001/catalog/products/9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f
   *
   * Resultado:
   * - Marca deletedAt (tombstone)
   * - Emite ProductChange(DELETE)
   * - Atualiza CatalogState.currentVersion
   */
  @Delete(':id')
  @ZodResponse({ type: EmitChangeResultDto })
  remove(@Param('id', uuidParamPipe) id: string): Promise<EmitChangeResultDto> {
    return this.writer.softDeleteProductAndEmitChange(id);
  }
}
