import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ZodValidationPipe } from 'src/common/pipes/zod-validation.pipe';
import { CatalogService } from 'src/modules/catalog/catalog.service';
import {
  type CatalogChangesQueryDto,
  CatalogChangesQuerySchema,
} from 'src/modules/catalog/dto/changes.query.schema';
import { CatalogChangesResponseDto } from 'src/modules/catalog/dto/changes.response.schema';
import {
  type CatalogHistoryQueryDto,
  CatalogHistoryQuerySchema,
} from 'src/modules/catalog/dto/history.query.schema';
import { CatalogHistoryResponseDto } from 'src/modules/catalog/dto/history.response.schema';
import {
  type CatalogSnapshotQueryDto,
  CatalogSnapshotQuerySchema,
} from 'src/modules/catalog/dto/snapshot.query.schema';
import { CatalogSnapshotResponseDto } from 'src/modules/catalog/dto/snapshot.response.schema';

/**
 * Pipes de validação Zod aplicados especificamente em @Query().
 *
 * Por que criar constantes?
 * - Evita instanciar o pipe a cada request (micro-otimização e deixa o código mais limpo).
 * - Mantém o controller “fino”: validação acontece no boundary (entrada).
 *
 * O que esses pipes fazem:
 * - Recebem o objeto de query string do Nest (tudo vem como string)
 * - Rodam `Schema.safeParse(...)`
 * - Convertem tipos usando o schema (ex.: z.coerce.number)
 * - Em caso de erro, lançam 400 (BadRequest) com detalhes.
 */
const catalogSnapshotQuerySchema = new ZodValidationPipe(
  CatalogSnapshotQuerySchema,
);
const catalogChangesQuerySchema = new ZodValidationPipe(
  CatalogChangesQuerySchema,
);
const catalogHistoryQuerySchema = new ZodValidationPipe(
  CatalogHistoryQuerySchema,
);

/**
 * Controller responsável pelo “contrato HTTP” do módulo de catálogo.
 *
 * Responsabilidade:
 * - Declarar rotas (URLs)
 * - Validar/transformar inputs (query) usando Zod
 * - Chamar o Service (lógica de negócio / acesso a dados)
 * - Tipar e documentar as respostas com Swagger via @ZodResponse
 *
 * Não é responsabilidade do Controller:
 * - Regras de paginação (como buscar no banco)
 * - Montagem de DTOs a partir do Prisma
 * - Qualquer regra de sync/delta (isso fica no Service)
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  /**
   * GET /catalog/snapshot
   *
   * Objetivo:
   * - Primeira carga do app (ou recarga total) do catálogo.
   * - Retorna produtos com preço/estoque + `currentVersion` do servidor.
   *
   * Paginação:
   * - Usa cursor por `Product.id` (UUID), que vem como `?cursor=<uuid>`
   * - Retorna `nextCursor` quando existem mais páginas
   *
   * Exemplos:
   *
   * 1) Primeira página (sem cursor)
   *    GET /catalog/snapshot
   *    GET /catalog/snapshot?limit=200
   *
   * 2) Próxima página (com cursor)
   *    GET /catalog/snapshot?limit=200&cursor=9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f
   *
   * Resposta (exemplo):
   * {
   *   "currentVersion": 3000,
   *   "items": [
   *     {
   *       "id": "....",
   *       "sku": "SKU-000001",
   *       "name": "Product name",
   *       "description": "...",
   *       "imageUrl": "https://...",
   *       "priceCents": 1090,
   *       "currency": "BRL",
   *       "stockOnHand": 42
   *     }
   *   ],
   *   "nextCursor": "...." // se houver próxima página
   * }
   *
   * Dica de sync (cliente):
   * - Guarde o `currentVersion` da PRIMEIRA resposta como `baseVersion`.
   * - Depois que terminar todas as páginas do snapshot, chame:
   *   GET /catalog/changes?sinceVersion=<baseVersion>
   *   para capturar mudanças que ocorreram durante o snapshot.
   */
  @Get('snapshot')
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Tamanho da página do snapshot (1..1000). Default: 200.',
    example: 200,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description:
      'UUID do Product.id para paginação. Quando informado, começa após este item.',
    example: '9a2d1b7f-7d8d-4f87-9f0b-2a0d1e2c3d4f',
  })
  @ApiQuery({
    name: 'withTotal',
    required: false,
    type: Boolean,
    description:
      'Quando true, inclui totalItems na resposta (útil para barra de progresso). Default: false.',
    example: true,
  })
  @ZodResponse({ type: CatalogSnapshotResponseDto })
  snapshot(
    @Query(catalogSnapshotQuerySchema)
    q: CatalogSnapshotQueryDto,
  ): Promise<CatalogSnapshotResponseDto> {
    return this.catalogService.snapshot(q);
  }

  /**
   * GET /catalog/changes
   *
   * Objetivo:
   * - Atualização incremental (delta sync).
   * - Retorna apenas mudanças desde a versão do cliente (`sinceVersion`).
   *
   * Como funciona:
   * - O cliente salva localmente `lastVersion`.
   * - Periodicamente (ou quando volta internet) chama:
   *   GET /catalog/changes?sinceVersion=<lastVersion>
   *
   * Exemplos:
   *
   * 1) Buscar mudanças desde a versão 0 (primeiro delta)
   *    GET /catalog/changes?sinceVersion=0
   *
   * 2) Buscar em páginas (quando tem muitas mudanças)
   *    GET /catalog/changes?sinceVersion=1200&limit=500
   *
   * Resposta (exemplo):
   * {
   *   "currentVersion": 1350,
   *   "changes": [
   *     {
   *       "type": "UPSERT",
   *       "version": 1201,
   *       "productId": "....",
   *       "product": { ...ProductDto }
   *     },
   *     {
   *       "type": "DELETE",
   *       "version": 1202,
   *       "productId": "...."
   *     }
   *   ]
   * }
   *
   * Regras:
   * - Se sinceVersion >= currentVersion, `changes` vem vazio.
   * - O cliente deve aplicar as mudanças em ordem e atualizar seu cursor:
   *   lastVersion = currentVersion (ou o maior version recebido)
   */
  @Get('changes')
  @ApiQuery({
    name: 'sinceVersion',
    required: true,
    type: Number,
    description:
      'Versão que o cliente já possui. Retorna mudanças com version > sinceVersion.',
    example: 0,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Máximo de mudanças por página (1..5000). Default: 500.',
    example: 500,
  })
  @ZodResponse({ type: CatalogChangesResponseDto })
  changes(
    @Query(catalogChangesQuerySchema)
    q: CatalogChangesQueryDto,
  ): Promise<CatalogChangesResponseDto> {
    return this.catalogService.changes(q);
  }

  @Get('history')
  @ApiQuery({
    name: 'sinceVersion',
    required: false,
    type: Number,
    description: 'Limite inferior. Retorna versões > sinceVersion. Default: 0.',
    example: 3000,
  })
  @ApiQuery({
    name: 'beforeVersion',
    required: false,
    type: Number,
    description:
      'Cursor para paginação DESC. Retorna versões < beforeVersion (exclusivo).',
    example: 3500,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Tamanho da página (1..5000). Default: 500.',
    example: 1000,
  })
  @ZodResponse({ type: CatalogHistoryResponseDto })
  history(
    @Query(catalogHistoryQuerySchema) q: CatalogHistoryQueryDto,
  ): Promise<CatalogHistoryResponseDto> {
    return this.catalogService.history(q);
  }
}
