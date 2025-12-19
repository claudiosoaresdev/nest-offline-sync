import { Injectable } from '@nestjs/common';
import {
  CatalogChangeType,
  Currency,
  Prisma,
} from 'src/generated/prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';
import type { CatalogChangesQueryDto } from 'src/modules/catalog/dto/changes.query.schema';
import type { CatalogChangesResponseDto } from 'src/modules/catalog/dto/changes.response.schema';
import type { CatalogChangeDto } from 'src/modules/catalog/dto/changes.response.schema';
import type { CatalogHistoryQueryDto } from 'src/modules/catalog/dto/history.query.schema';
import type { CatalogHistoryResponseDto } from 'src/modules/catalog/dto/history.response.schema';
import type { ProductDto } from 'src/modules/catalog/dto/product.schema';
import type { CatalogSnapshotQueryDto } from 'src/modules/catalog/dto/snapshot.query.schema';
import type { CatalogSnapshotResponseDto } from 'src/modules/catalog/dto/snapshot.response.schema';

/**
 * Tipo Prisma para buscar Product já com seus relacionamentos necessários
 * para montar o DTO que o frontend consome:
 * - price (ProductPrice 1:1)
 * - inventory (Inventory 1:1)
 */
type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { price: true; inventory: true };
}>;

type ProductChangeWithProduct = Prisma.ProductChangeGetPayload<{
  include: { product: { include: { price: true; inventory: true } } };
}>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lê a versão global atual do catálogo.
   *
   * Por que existe:
   * - O cliente salva `currentVersion` localmente.
   * - No delta sync, ele chama `/catalog/changes?sinceVersion=<version>`
   *   e recebe apenas mudanças com `version > sinceVersion`.
   *
   * Robustez:
   * - Se o seed não rodou (ambiente novo), cria o singleton "global"
   *   para evitar quebrar a API.
   */
  private async getCurrentVersion(): Promise<number> {
    const state = await this.prisma.catalogState.findUnique({
      where: { id: 'global' },
      select: { currentVersion: true },
    });

    // Se seed não rodou (ambiente novo), garante existir sem quebrar
    if (!state) {
      const created = await this.prisma.catalogState.create({
        data: { id: 'global', currentVersion: 0 },
        select: { currentVersion: true },
      });
      return created.currentVersion;
    }

    return state.currentVersion;
  }

  /**
   * Converte o modelo do banco (Product + relations) para o DTO que o frontend usa.
   *
   * Decisões importantes:
   * - Preço em centavos (priceCents) para evitar float.
   * - Fallbacks seguros caso preço/estoque ainda não existam.
   * - Campos opcionais/nullable para bater com o contrato Zod.
   */
  private toProductDto(p: ProductWithRelations): ProductDto {
    return {
      id: p.id,
      sku: p.sku ?? null,
      name: p.name,
      description: p.description ?? null,
      imageUrl: p.imageUrl ?? null,
      priceCents: p.price?.priceCents ?? 0,
      currency: p.price?.currency ?? Currency.BRL,
      stockOnHand: p.inventory?.stockOnHand ?? 0,
    };
  }

  private tryProductFromPayload(
    payload: Prisma.JsonValue | null,
  ): ProductDto | null {
    if (!payload || !isRecord(payload)) return null;

    const prod = isRecord(payload['product']) ? payload['product'] : null;
    const price = isRecord(payload['price']) ? payload['price'] : null;
    const inv = isRecord(payload['inventory']) ? payload['inventory'] : null;

    if (!prod || !price || !inv) return null;

    const id = asString(prod['id']);
    const sku = asString(prod['sku']);
    const name = asString(prod['name']);
    const description = asString(prod['description']);
    const imageUrl = asString(prod['imageUrl']);

    const priceCents = asNumber(price['priceCents']);
    const currency = asString(price['currency']);
    const stockOnHand = asNumber(inv['stockOnHand']);

    if (
      !id ||
      !name ||
      priceCents === null ||
      !currency ||
      stockOnHand === null
    )
      return null;

    return {
      id,
      sku: sku ?? null,
      name,
      description: description ?? null,
      imageUrl: imageUrl ?? null,
      priceCents: Math.trunc(priceCents),
      currency: currency as Currency,
      stockOnHand: Math.trunc(stockOnHand),
    };
  }

  /**
   * Converte ProductDto para o formato esperado pelo history schema,
   * garantindo que stockOnHand seja sempre um número (não opcional).
   */
  private toProductHistoryDto(product: ProductDto): ProductDto & {
    stockOnHand: number;
  } {
    return {
      ...product,
      stockOnHand: product.stockOnHand ?? 0,
    };
  }

  /**
   * SNAPSHOT (primeira carga do app)
   *
   * Endpoint:
   * - GET /catalog/snapshot?limit=200&cursor=<productId>&withTotal=1
   *
   * Objetivo:
   * - Permitir o download progressivo do catálogo (paginado) para o app exibir barra de progresso.
   * - Retornar uma página de produtos (com preço e estoque) + metadados do snapshot.
   *
   * Metadados retornados:
   * - currentVersion:
   *   Versão global atual do catálogo no servidor (use como `baseVersion`).
   * - totalItems (opcional):
   *   Total de produtos (não deletados) disponíveis no snapshot. Útil para calcular progresso:
   *   progresso = downloaded / totalItems.
   *   Por performance, esse count é feito somente quando `withTotal=1` (tipicamente só na 1ª página).
   *
   * Paginação:
   * - Cursor consistente por `Product.id` (UUID, único, estável).
   * - Ordenação fixa por `id asc`.
   * - Busca `limit + 1` itens para detectar se existe próxima página.
   * - `nextCursor` vem apenas quando existe próxima página.
   *
   * Observação importante (consistência):
   * - O catálogo pode mudar enquanto você pagina o snapshot.
   * - Estratégia recomendada no cliente:
   *   1) Chamar a 1ª página com `withTotal=1` e salvar `baseVersion = currentVersion`.
   *   2) Baixar todas as páginas seguindo `nextCursor` até ele não existir.
   *   3) Ao finalizar, chamar:
   *      GET /catalog/changes?sinceVersion=<baseVersion>
   *      para capturar mudanças ocorridas durante o snapshot.
   */
  async snapshot(
    q: CatalogSnapshotQueryDto,
  ): Promise<CatalogSnapshotResponseDto> {
    const currentVersion = await this.getCurrentVersion();

    // limit vem validado pelo Zod; aqui só aplicamos fallback por segurança
    const limit = q.limit ?? 200;

    // técnica comum: pegar +1 item para decidir se existe próxima página
    const take = limit + 1;

    // totalItems é opcional e só calculado quando o client pede (1ª página, p/ barra de progresso)
    const [rows, totalItems] = await Promise.all([
      this.prisma.product.findMany({
        // snapshot não deve trazer itens deletados (soft delete)
        where: { deletedAt: null },

        // ordenação fixa garante paginação consistente
        orderBy: { id: 'asc' },

        // pega 1 a mais para verificar "hasMore"
        take,

        // se cursor foi informado, começa "depois" daquele item
        ...(q.cursor
          ? {
              cursor: { id: q.cursor },
              skip: 1,
            }
          : {}),

        // traz relações necessárias para montar DTO
        include: { price: true, inventory: true },
      }),

      q.withTotal
        ? this.prisma.product.count({ where: { deletedAt: null } })
        : Promise.resolve(undefined),
    ]);

    // se veio mais do que limit, existe próxima página
    const hasMore = rows.length > limit;

    // a página efetiva são os primeiros `limit`
    const page = hasMore ? rows.slice(0, limit) : rows;

    // monta o payload esperado pelo frontend
    const items = page.map((p) => this.toProductDto(p));

    // cursor da próxima página = último id desta página
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return {
      currentVersion,
      totalItems, // opcional (vem apenas quando withTotal=true)
      items,
      nextCursor,
    };
  }

  /**
   * CHANGES (delta sync / atualização incremental)
   *
   * Endpoint: GET /catalog/changes?sinceVersion=123&limit=500
   *
   * O que ele faz:
   * - Retorna mudanças desde `sinceVersion` com base no log `ProductChange`.
   * - Retorna a `currentVersion` do servidor (para o cliente atualizar seu cursor).
   *
   * Cursor:
   * - `sinceVersion` é o cursor do cliente.
   * - `ProductChange.version` é autoincrement (monótono) e ordenável.
   *
   * Performance:
   * - Primeiro busca só a lista "raw" (version/type/productId).
   * - Depois busca os produtos (com preço/estoque) somente para UPSERTs.
   *
   * Por que UPSERT precisa do produto completo:
   * - Para o client aplicar rápido sem ter que fazer N chamadas por item.
   *
   * Tratamento de inconsistência:
   * - Se existir UPSERT mas o produto estiver deletado ou não for encontrado,
   *   degradamos para DELETE (o client remove localmente).
   */
  async changes(q: CatalogChangesQueryDto): Promise<CatalogChangesResponseDto> {
    const currentVersion = await this.getCurrentVersion();

    // Se o cliente já tem a versão atual (ou maior), não há o que enviar
    if (q.sinceVersion >= currentVersion) {
      return { currentVersion, changes: [] };
    }

    // Busca o log de alterações (delta)
    const rawChanges = await this.prisma.productChange.findMany({
      where: { version: { gt: q.sinceVersion } }, // somente mudanças depois do cursor
      orderBy: { version: 'asc' }, // sempre crescente
      take: q.limit ?? 500, // limite (Zod valida max)
      select: {
        version: true,
        type: true,
        productId: true,
      },
    });

    // Separa ids que precisam de UPSERT (precisamos do produto completo nesses casos)
    const upsertIds = rawChanges
      .filter((c) => c.type === CatalogChangeType.UPSERT)
      .map((c) => c.productId);

    // Busca produtos apenas para UPSERTs (inclui preço e estoque)
    const products = upsertIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: upsertIds } },
          include: { price: true, inventory: true },
        })
      : [];

    // Indexa por id para lookup rápido durante o map
    const byId = new Map<string, ProductWithRelations>();
    for (const p of products) byId.set(p.id, p);

    // Monta o array de changes no formato do contrato (Zod discriminated union)
    const changes: CatalogChangeDto[] = rawChanges.map((c) => {
      // DELETE: basta mandar productId + version (client remove local)
      if (c.type === CatalogChangeType.DELETE) {
        return {
          type: CatalogChangeType.DELETE,
          version: c.version,
          productId: c.productId,
        };
      }

      // UPSERT: precisa mandar product completo
      const p = byId.get(c.productId);

      // Se não achou ou está soft-deletado, tratamos como DELETE
      if (!p || p.deletedAt) {
        return {
          type: CatalogChangeType.DELETE,
          version: c.version,
          productId: c.productId,
        };
      }

      return {
        type: CatalogChangeType.UPSERT,
        version: c.version,
        productId: c.productId,
        product: this.toProductDto(p),
      };
    });

    return { currentVersion, changes };
  }

  /**
   * HISTORY (log paginado DESC: mais novo -> mais antigo)
   * Endpoint: GET /catalog/history?sinceVersion=3000&limit=1000&beforeVersion=...
   */
  async history(q: CatalogHistoryQueryDto): Promise<CatalogHistoryResponseDto> {
    const currentVersion = await this.getCurrentVersion();

    const sinceVersion = q.sinceVersion ?? 0;
    const limit = q.limit ?? 500;

    // cursor DESC: se não veio, começa do "topo" (currentVersion + 1) para incluir currentVersion
    const beforeVersion =
      typeof q.beforeVersion === 'number'
        ? q.beforeVersion
        : currentVersion + 1;

    // se já está "acima" do topo, normaliza para não dar vazio à toa
    const effectiveBefore = Math.max(1, beforeVersion);

    // nada a retornar (range vazio)
    if (sinceVersion >= currentVersion) {
      return { currentVersion, changes: [], hasMore: false };
    }

    const take = limit + 1;

    const rows: ProductChangeWithProduct[] =
      await this.prisma.productChange.findMany({
        where: {
          version: { gt: sinceVersion, lt: effectiveBefore },
        },
        orderBy: { version: 'desc' }, // ✅ mais novo primeiro
        take,
        include: { product: { include: { price: true, inventory: true } } },
      });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const changes = page.map((r) => {
      const at = r.createdAt.toISOString();

      // Preferir payload (snapshot no momento do change), fallback para estado atual do produto (soft-delete mantém)
      const fromPayload = this.tryProductFromPayload(r.payload);
      const productDto = fromPayload ?? this.toProductDto(r.product);
      // Garante que stockOnHand seja sempre um número para o history schema
      const productHistory = this.toProductHistoryDto(productDto);

      if (r.type === CatalogChangeType.DELETE) {
        const deletedAtIso =
          isRecord(r.payload) && typeof r.payload['deletedAt'] === 'string'
            ? r.payload['deletedAt']
            : r.product.deletedAt
              ? r.product.deletedAt.toISOString()
              : undefined;

        return {
          type: CatalogChangeType.DELETE,
          version: r.version,
          at,
          productId: r.productId,
          deletedAt: deletedAtIso,
          product: productHistory,
        };
      }

      return {
        type: CatalogChangeType.UPSERT,
        version: r.version,
        at,
        productId: r.productId,
        product: productHistory,
      };
    });

    const nextBeforeVersion = hasMore
      ? page[page.length - 1].version // menor versão desta página (mais antiga no page)
      : undefined;

    return {
      currentVersion,
      changes,
      hasMore,
      nextBeforeVersion,
    };
  }
}
