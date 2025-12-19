import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CatalogChangeType,
  Currency,
  Prisma,
} from 'src/generated/prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';
import { EmitChangeResultSchema } from 'src/modules/catalog-write/dto/emit-change-result.schema';
import { UpsertProductInputSchema } from 'src/modules/catalog-write/dto/upsert-product.input.schema';
import { NotificationsService } from 'src/modules/notifications/notifications.service';

/**
 * Service interno ("writer") do catálogo.
 *
 * Responsabilidade:
 * - Garantir que toda mudança no catálogo (create/update/delete)
 *   gere um registro em ProductChange (UPSERT/DELETE)
 * - Atualizar CatalogState.currentVersion de forma MONÓTONA
 *   (não pode regredir mesmo com concorrência)
 *
 * Por que existe:
 * - O delta sync (/catalog/changes) depende 100% do ProductChange.
 * - Se você atualizar ProductPrice direto e esquecer de emitir change,
 *   o cliente nunca vai saber da mudança.
 */
@Injectable()
export class CatalogWriterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * CatalogState é um singleton (id="global").
   * Se o seed não rodou, criamos aqui para evitar quebrar o writer.
   */
  private async ensureCatalogState(tx: Prisma.TransactionClient) {
    await tx.catalogState.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', currentVersion: 0 },
    });
  }

  /**
   * Atualiza currentVersion sem risco de "regredir" em concorrência.
   *
   * Problema:
   * - tx A cria change.version = 100
   * - tx B cria change.version = 101
   * - tx B commita primeiro e seta currentVersion=101
   * - tx A commita depois e setaria currentVersion=100 (ERRADO)
   *
   * Solução:
   * - Update condicionado: só atualiza se currentVersion < newVersion
   */
  private async bumpCatalogVersionMonotonic(
    tx: Prisma.TransactionClient,
    newVersion: number,
  ) {
    await tx.catalogState.updateMany({
      where: { id: 'global', currentVersion: { lt: newVersion } },
      data: { currentVersion: newVersion },
    });
  }

  /**
   * UPSERT transacional:
   * 1) upsert em Product (por id OU por sku; senão cria)
   * 2) upsert em ProductPrice (1:1)
   * 3) upsert em Inventory (1:1)
   * 4) cria ProductChange (UPSERT) com payload mínimo (opcional)
   * 5) atualiza CatalogState.currentVersion (monótono)
   *
   * ✅ Após commit: emite notificação WS "CATALOG_ITEMS_UPDATED"
   */
  async upsertProductAndEmitChange(input: unknown) {
    const data = UpsertProductInputSchema.parse(input);

    const currency = data.currency ?? Currency.BRL;
    const stockOnHand = data.stockOnHand ?? 0;
    const emitPayload = data.emitPayload ?? true;

    const rawResult = await this.prisma.$transaction(async (tx) => {
      await this.ensureCatalogState(tx);

      const sku =
        typeof data.sku === 'string' && data.sku.trim().length > 0
          ? data.sku.trim()
          : undefined;

      const product = await (async () => {
        if (data.id) {
          return tx.product.upsert({
            where: { id: data.id },
            update: {
              sku: sku ?? undefined,
              name: data.name,
              description: data.description ?? null,
              imageUrl: data.imageUrl ?? null,
              deletedAt: null,
            },
            create: {
              id: data.id,
              sku: sku ?? null,
              name: data.name,
              description: data.description ?? null,
              imageUrl: data.imageUrl ?? null,
              deletedAt: null,
            },
            select: { id: true, sku: true, name: true, imageUrl: true },
          });
        }

        if (sku) {
          return tx.product.upsert({
            where: { sku },
            update: {
              name: data.name,
              description: data.description ?? null,
              imageUrl: data.imageUrl ?? null,
              deletedAt: null,
            },
            create: {
              sku,
              name: data.name,
              description: data.description ?? null,
              imageUrl: data.imageUrl ?? null,
              deletedAt: null,
            },
            select: { id: true, sku: true, name: true, imageUrl: true },
          });
        }

        return tx.product.create({
          data: {
            sku: null,
            name: data.name,
            description: data.description ?? null,
            imageUrl: data.imageUrl ?? null,
            deletedAt: null,
          },
          select: { id: true, sku: true, name: true, imageUrl: true },
        });
      })();

      await tx.productPrice.upsert({
        where: { productId: product.id },
        update: { priceCents: data.priceCents, currency },
        create: {
          productId: product.id,
          priceCents: data.priceCents,
          currency,
        },
      });

      await tx.inventory.upsert({
        where: { productId: product.id },
        update: { stockOnHand },
        create: { productId: product.id, stockOnHand },
      });

      const change = await tx.productChange.create({
        data: {
          type: CatalogChangeType.UPSERT,
          productId: product.id,
          payload: emitPayload
            ? {
                product: {
                  id: product.id,
                  sku: product.sku,
                  name: product.name,
                  imageUrl: product.imageUrl,
                },
                price: { priceCents: data.priceCents, currency },
                inventory: { stockOnHand },
              }
            : undefined,
        },
        select: { version: true },
      });

      await this.bumpCatalogVersionMonotonic(tx, change.version);

      const state = await tx.catalogState.findUnique({
        where: { id: 'global' },
        select: { currentVersion: true },
      });

      return {
        productId: product.id,
        changeVersion: change.version,
        currentVersion: state?.currentVersion ?? change.version,
      };
    });

    // ✅ valida retorno pelo schema (sem type)
    const result = EmitChangeResultSchema.parse(rawResult);

    // ✅ emite WS após commit
    try {
      this.notifications.emitCatalogItemsUpdated({
        productId: result.productId,
        action: 'UPSERT',
        changeVersion: result.changeVersion,
        currentVersion: result.currentVersion,
      });
    } catch {
      // não derruba a request por falha de notificação
    }

    return result;
  }

  /**
   * DELETE transacional (tombstone / soft delete):
   * 1) marca Product.deletedAt
   * 2) cria ProductChange (DELETE)
   * 3) atualiza versão global (monótona)
   *
   * ✅ Após commit: emite notificação WS "CATALOG_ITEMS_UPDATED"
   */
  async softDeleteProductAndEmitChange(productId: string) {
    const rawResult = await this.prisma.$transaction(async (tx) => {
      await this.ensureCatalogState(tx);

      const existing = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });

      if (!existing) throw new NotFoundException('Product not found');

      const deletedAt = new Date();

      await tx.product.update({
        where: { id: productId },
        data: { deletedAt },
      });

      const change = await tx.productChange.create({
        data: {
          type: CatalogChangeType.DELETE,
          productId,
          payload: { deletedAt: deletedAt.toISOString() },
        },
        select: { version: true },
      });

      await this.bumpCatalogVersionMonotonic(tx, change.version);

      const state = await tx.catalogState.findUnique({
        where: { id: 'global' },
        select: { currentVersion: true },
      });

      return {
        productId,
        changeVersion: change.version,
        currentVersion: state?.currentVersion ?? change.version,
      };
    });

    const result = EmitChangeResultSchema.parse(rawResult);

    try {
      this.notifications.emitCatalogItemsUpdated({
        productId: result.productId,
        action: 'DELETE',
        changeVersion: result.changeVersion,
        currentVersion: result.currentVersion,
      });
    } catch {
      // não derruba a request por falha de notificação
    }

    return result;
  }
}
