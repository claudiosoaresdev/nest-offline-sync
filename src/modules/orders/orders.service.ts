import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CatalogChangeType,
  Currency,
  OrderEventType,
  OrderStatus,
  Prisma,
} from 'src/generated/prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';
import {
  type OrderEventMessage,
  OrderEventsService,
} from 'src/modules/events/order-events.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';
import {
  type ConfirmOrderDto,
  ConfirmOrderSchema,
} from 'src/modules/orders/dto/confirm-order.schema';
import type { CreateOrderResponseDto } from 'src/modules/orders/dto/create-order.response.schema';
import {
  type CreateOrderDto,
  CreateOrderSchema,
} from 'src/modules/orders/dto/create-order.schema';
import type { OrderDto } from 'src/modules/orders/dto/order.schema';
import { type OrderDiffDto } from 'src/modules/orders/dto/order-diff.schema';

import {
  OrdersListQueryDto,
  OrdersListQuerySchema,
} from './dto/orders-list.schema';

type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { price: true; inventory: true };
}>;

// ✅ decisão do fluxo: quando não há diffs no CREATE, confirmar automaticamente
// ⚠️ Desabilitado: pedidos devem ser confirmados manualmente através do modal
const AUTO_CONFIRM_WHEN_NO_DIFF = false;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Converte qualquer coisa em um JSON válido para Prisma.InputJsonValue.
 *
 * ⚠️ Importante: no seu Prisma, InputJsonValue NÃO aceita null nem sentinels.
 * Então:
 * - null/undefined => vira undefined (e o chamador deve omitir o campo)
 * - em objetos: omitimos chaves com undefined
 * - em arrays: filtramos valores undefined
 */
function toPrismaInputJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const out: Prisma.InputJsonValue[] = [];
    for (const item of value) {
      const normalized = toPrismaInputJson(item);
      if (normalized !== undefined) out.push(normalized);
    }
    return out as unknown as Prisma.InputJsonValue;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, Prisma.InputJsonValue> = {};

    for (const [k, v] of Object.entries(obj)) {
      const normalized = toPrismaInputJson(v);
      if (normalized === undefined) continue; // omite chave
      out[k] = normalized;
    }

    return out as unknown as Prisma.InputJsonValue;
  }

  // function / symbol / etc.
  return undefined;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderEvents: OrderEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Cria e retorna o evento persistido (para replay/SSE).
   * Publique no in-memory apenas após commit (fora do tx).
   */
  private async createEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    type: OrderEventType,
    payload?: unknown,
  ): Promise<OrderEventMessage> {
    const normalizedPayload = toPrismaInputJson(payload);

    const ev = await tx.orderEvent.create({
      data: {
        orderId,
        type,
        payload: normalizedPayload, // pode ser undefined => coluna NULL (Json?)
      },
      select: {
        id: true,
        orderId: true,
        type: true,
        payload: true,
        createdAt: true,
      },
    });

    return {
      id: ev.id,
      orderId: ev.orderId,
      type: ev.type,
      payload: (ev.payload ?? null) as Prisma.JsonValue | null,
      createdAt: ev.createdAt.toISOString(),
    };
  }

  /**
   * Garante que CatalogState existe (singleton id="global").
   */
  private async ensureCatalogState(tx: Prisma.TransactionClient) {
    await tx.catalogState.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', currentVersion: 0 },
    });
  }

  /**
   * Atualiza currentVersion de forma monótona (evita regressão em concorrência).
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
   * Decrementa estoque de forma segura e cria ProductChange para delta sync.
   * Retorna os productIds afetados e informações de versão.
   */
  private async decrementInventoryAndEmitChange(
    tx: Prisma.TransactionClient,
    items: Array<{ productId: string; qty: number }>,
    productsById: Map<string, ProductWithRelations>,
  ): Promise<{
    affectedProductIds: string[];
    changeVersions: Map<string, number>;
    currentVersion: number;
    stockErrors: OrderDiffDto[];
  }> {
    await this.ensureCatalogState(tx);

    const affectedProductIds: string[] = [];
    const changeVersions = new Map<string, number>();
    const stockErrors: OrderDiffDto[] = [];

    // Agrupa quantidade por produto (caso o mesmo produto apareça múltiplas vezes)
    const qtyByProduct = new Map<string, number>();
    for (const item of items) {
      qtyByProduct.set(
        item.productId,
        (qtyByProduct.get(item.productId) ?? 0) + item.qty,
      );
    }

    // Decrementa estoque e cria ProductChange para cada produto afetado
    for (const [productId, totalQty] of qtyByProduct.entries()) {
      const product = productsById.get(productId);
      if (!product?.inventory) continue;

      // Decremento seguro: só decrementa se estoque >= quantidade
      const dec = await tx.inventory.updateMany({
        where: {
          productId,
          stockOnHand: { gte: totalQty },
        },
        data: {
          stockOnHand: { decrement: totalQty },
        },
      });

      if (dec.count === 0) {
        // Estoque insuficiente na confirmação (race condition)
        const currentStock = product.inventory.stockOnHand;
        stockErrors.push({
          productId,
          kind: 'OUT_OF_STOCK',
          stockOnHand: currentStock,
          message: 'Estoque insuficiente na confirmação',
        });
        continue;
      }

      // Busca o produto atualizado com estoque decrementado para criar snapshot no ProductChange
      const updatedProduct = await tx.product.findUnique({
        where: { id: productId },
        include: { price: true, inventory: true },
      });

      if (!updatedProduct) continue;

      // Cria ProductChange para delta sync
      const change = await tx.productChange.create({
        data: {
          type: CatalogChangeType.UPSERT,
          productId,
          payload: {
            product: {
              id: updatedProduct.id,
              sku: updatedProduct.sku,
              name: updatedProduct.name,
              imageUrl: updatedProduct.imageUrl,
            },
            price: updatedProduct.price
              ? {
                  priceCents: updatedProduct.price.priceCents,
                  currency: updatedProduct.price.currency,
                }
              : null,
            inventory: updatedProduct.inventory
              ? { stockOnHand: updatedProduct.inventory.stockOnHand }
              : null,
          },
        },
        select: { version: true },
      });

      affectedProductIds.push(productId);
      changeVersions.set(productId, change.version);

      // Atualiza CatalogState.currentVersion de forma monótona
      await this.bumpCatalogVersionMonotonic(tx, change.version);
    }

    // Busca currentVersion final
    const state = await tx.catalogState.findUnique({
      where: { id: 'global' },
      select: { currentVersion: true },
    });

    return {
      affectedProductIds,
      changeVersions,
      currentVersion: state?.currentVersion ?? 0,
      stockErrors,
    };
  }

  /**
   * Decide status do pedido no CREATE (compatível com seu enum real).
   */
  private decideStatusOnCreate(diffs: OrderDiffDto[]): OrderStatus {
    const hasHardBlock = diffs.some(
      (d) =>
        d.kind === 'NOT_FOUND' ||
        d.kind === 'DELETED' ||
        d.kind === 'OUT_OF_STOCK',
    );
    if (hasHardBlock) return OrderStatus.REJECTED;

    const hasPrice = diffs.some((d) => d.kind === 'PRICE_CHANGED');
    if (hasPrice) return OrderStatus.REQUIRES_CONFIRMATION;

    return AUTO_CONFIRM_WHEN_NO_DIFF
      ? OrderStatus.CONFIRMED
      : OrderStatus.PENDING_VALIDATION;
  }

  private async loadProductsMap(
    tx: Prisma.TransactionClient,
    productIds: string[],
  ): Promise<Map<string, ProductWithRelations>> {
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      include: { price: true, inventory: true },
    });

    const byId = new Map<string, ProductWithRelations>();
    for (const p of products) byId.set(p.id, p);

    return byId;
  }

  private repriceLines(args: {
    items: Array<{
      productId: string;
      qty: number;
      clientPriceCents: number;
      previousServerPriceCents?: number | null;
    }>;
    productsById: Map<string, ProductWithRelations>;
    mode: 'CREATE' | 'CONFIRM';
  }) {
    const diffs: OrderDiffDto[] = [];
    const itemViews: Array<{
      productId: string;
      qty: number;
      clientPriceCents: number;
      serverPriceCents: number | null;
      productNameSnapshot?: string | null;
      productSkuSnapshot?: string | null;
      productImageSnapshot?: string | null;
    }> = [];

    // soma qty por produto (evita under-check se vier duplicado)
    const qtyByProduct = new Map<string, number>();
    for (const it of args.items) {
      qtyByProduct.set(
        it.productId,
        (qtyByProduct.get(it.productId) ?? 0) + it.qty,
      );
    }

    let totalCents = 0;

    for (const it of args.items) {
      const p = args.productsById.get(it.productId);

      if (!p) {
        diffs.push({
          productId: it.productId,
          kind: 'NOT_FOUND',
          message: 'Produto não encontrado',
        });

        itemViews.push({
          productId: it.productId,
          qty: it.qty,
          clientPriceCents: it.clientPriceCents,
          serverPriceCents: null,
        });
        continue;
      }

      if (p.deletedAt) {
        diffs.push({
          productId: it.productId,
          kind: 'DELETED',
          message: 'Produto removido do catálogo',
        });

        itemViews.push({
          productId: it.productId,
          qty: it.qty,
          clientPriceCents: it.clientPriceCents,
          serverPriceCents: null,
          productNameSnapshot: p.name,
          productSkuSnapshot: p.sku ?? null,
          productImageSnapshot: p.imageUrl ?? null,
        });
        continue;
      }

      const serverPriceCents = p.price?.priceCents ?? 0;

      // estoque (se existir Inventory)
      const stockOnHand = p.inventory?.stockOnHand ?? 0;
      const totalQtyForThisProduct = qtyByProduct.get(it.productId) ?? it.qty;

      if (p.inventory && totalQtyForThisProduct > stockOnHand) {
        diffs.push({
          productId: it.productId,
          kind: 'OUT_OF_STOCK',
          stockOnHand,
          message: 'Estoque insuficiente',
        });
      }

      // preço
      if (args.mode === 'CREATE') {
        if (serverPriceCents !== it.clientPriceCents) {
          diffs.push({
            productId: it.productId,
            kind: 'PRICE_CHANGED',
            clientPriceCents: it.clientPriceCents,
            serverPriceCents,
            message: 'Preço mudou desde o offline',
          });
        }
      } else {
        const prev = it.previousServerPriceCents ?? null;
        if (prev !== null && serverPriceCents !== prev) {
          diffs.push({
            productId: it.productId,
            kind: 'PRICE_CHANGED',
            previousServerPriceCents: prev,
            serverPriceCents,
            message: 'Preço mudou novamente antes da confirmação',
          });
        }
      }

      totalCents += serverPriceCents * it.qty;

      itemViews.push({
        productId: it.productId,
        qty: it.qty,
        clientPriceCents: it.clientPriceCents,
        serverPriceCents,
        productNameSnapshot: p.name,
        productSkuSnapshot: p.sku ?? null,
        productImageSnapshot: p.imageUrl ?? null,
      });
    }

    return { diffs, totalCents, itemViews };
  }

  /**
   * POST /orders
   */
  async createOrder(input: CreateOrderDto): Promise<CreateOrderResponseDto> {
    const dto = CreateOrderSchema.parse(input);
    let inventoryResultForNotification:
      | {
          affectedProductIds: string[];
          changeVersions: Map<string, number>;
          currentVersion: number;
        }
      | undefined;

    // Idempotência por clientRequestId (domínio)
    if (dto.clientRequestId) {
      const existing = await this.prisma.order.findUnique({
        where: { clientRequestId: dto.clientRequestId },
        include: { items: true },
      });

      if (existing) {
        const lastValidated = await this.prisma.orderEvent.findFirst({
          where: { orderId: existing.id, type: OrderEventType.ORDER_VALIDATED },
          orderBy: { createdAt: 'desc' },
          select: { payload: true },
        });

        let diffs: OrderDiffDto[] = [];
        const payload = lastValidated?.payload;

        if (isRecord(payload) && Array.isArray((payload as any).diffs)) {
          diffs = (payload as any).diffs as OrderDiffDto[];
        }

        return {
          orderId: existing.id,
          status: existing.status,
          currency: existing.currency,
          totalCents: existing.totalCents,
          diffs,
          items: existing.items.map((it) => ({
            productId: it.productId,
            qty: it.qty,
            clientPriceCents: it.clientPriceCents,
            serverPriceCents: it.serverPriceCents ?? null,
            productNameSnapshot: it.productNameSnapshot ?? null,
            productSkuSnapshot: it.productSkuSnapshot ?? null,
            productImageSnapshot: it.productImageSnapshot ?? null,
          })),
        };
      }
    }

    const emitted: OrderEventMessage[] = [];

    const result = await this.prisma.$transaction(async (tx) => {
      const productIds = Array.from(new Set(dto.items.map((i) => i.productId)));
      const productsById = await this.loadProductsMap(tx, productIds);

      const { diffs, totalCents, itemViews } = this.repriceLines({
        items: dto.items.map((i) => ({
          productId: i.productId,
          qty: i.qty,
          clientPriceCents: i.clientPriceCents,
        })),
        productsById,
        mode: 'CREATE',
      });

      const status = this.decideStatusOnCreate(diffs);

      const order = await tx.order.create({
        data: {
          status: OrderStatus.PENDING_VALIDATION,
          clientCatalogVersion: dto.clientCatalogVersion,
          totalCents: 0,
          currency: Currency.BRL,
          clientRequestId: dto.clientRequestId ?? null,
          items: {
            create: itemViews.map((v) => ({
              productId: v.productId,
              qty: v.qty,
              clientPriceCents: v.clientPriceCents,
              serverPriceCents: v.serverPriceCents ?? null,
              productNameSnapshot: v.productNameSnapshot ?? null,
              productSkuSnapshot: v.productSkuSnapshot ?? null,
              productImageSnapshot: v.productImageSnapshot ?? null,
            })),
          },
        },
        select: { id: true },
      });

      emitted.push(
        await this.createEvent(tx, order.id, OrderEventType.ORDER_CREATED, {
          clientCatalogVersion: dto.clientCatalogVersion,
          clientRequestId: dto.clientRequestId ?? null,
          itemsCount: dto.items.length,
        }),
      );

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status, totalCents, currency: Currency.BRL },
        select: { id: true, status: true, totalCents: true, currency: true },
      });

      emitted.push(
        await this.createEvent(tx, order.id, OrderEventType.ORDER_VALIDATED, {
          status,
          totalCents,
          diffs,
        }),
      );

      const priceDiffs = diffs.filter((d) => d.kind === 'PRICE_CHANGED');
      if (priceDiffs.length > 0) {
        emitted.push(
          await this.createEvent(tx, order.id, OrderEventType.PRICE_CHANGED, {
            diffs: priceDiffs,
          }),
        );
      }

      // Variáveis para armazenar resultado do decremento (se AUTO_CONFIRM)
      let inventoryResult:
        | {
            affectedProductIds: string[];
            changeVersions: Map<string, number>;
            currentVersion: number;
            stockErrors: OrderDiffDto[];
          }
        | undefined;
      let finalStatus = updated.status;
      let finalDiffs = diffs;

      if (diffs.length === 0) {
        emitted.push(
          await this.createEvent(tx, order.id, OrderEventType.READY_TO_CONFIRM),
        );

        if (AUTO_CONFIRM_WHEN_NO_DIFF && status === OrderStatus.CONFIRMED) {
          // ✅ Decrementa estoque de forma segura e cria ProductChange
          inventoryResult = await this.decrementInventoryAndEmitChange(
            tx,
            itemViews.map((v) => ({ productId: v.productId, qty: v.qty })),
            productsById,
          );

          // Se houver erros de estoque, muda status para REJECTED
          if (inventoryResult.stockErrors.length > 0) {
            finalStatus = OrderStatus.REJECTED;
            finalDiffs = inventoryResult.stockErrors;

            await tx.order.update({
              where: { id: order.id },
              data: { status: finalStatus },
            });

            emitted.push(
              await this.createEvent(tx, order.id, OrderEventType.ORDER_VALIDATED, {
                status: finalStatus,
                totalCents,
                diffs: finalDiffs,
              }),
            );

            emitted.push(
              await this.createEvent(tx, order.id, OrderEventType.ORDER_REJECTED, {
                diffs: finalDiffs,
              }),
            );
          } else {
            emitted.push(
              await this.createEvent(
                tx,
                order.id,
                OrderEventType.ORDER_CONFIRMED,
                {
                  totalCents,
                },
              ),
            );
          }
        }
      }

      if (finalStatus === OrderStatus.REJECTED) {
        emitted.push(
          await this.createEvent(tx, order.id, OrderEventType.ORDER_REJECTED, {
            diffs: finalDiffs,
          }),
        );
      }

      // Atualiza updated se status mudou
      if (finalStatus !== updated.status) {
        const finalOrder = await tx.order.findUnique({
          where: { id: order.id },
          select: { id: true, status: true, totalCents: true, currency: true },
        });
        if (finalOrder) {
          (updated as any) = finalOrder;
        }
      }

      // Armazena inventoryResult para notificação após commit (fora da transação)
      if (inventoryResult && inventoryResult.stockErrors.length === 0) {
        inventoryResultForNotification = {
          affectedProductIds: inventoryResult.affectedProductIds,
          changeVersions: inventoryResult.changeVersions,
          currentVersion: inventoryResult.currentVersion,
        };
      }

      return {
        orderId: updated.id,
        status: finalStatus,
        currency: updated.currency,
        totalCents: updated.totalCents,
        diffs: finalDiffs,
        items: itemViews,
      };
    });

    // ✅ só publica depois do commit
    for (const ev of emitted) this.orderEvents.publish(ev);

    // ✅ Emite notificações de mudança de catálogo após commit (se AUTO_CONFIRM)
    if (inventoryResultForNotification && inventoryResultForNotification.affectedProductIds.length > 0) {
      for (const productId of inventoryResultForNotification.affectedProductIds) {
        const changeVersion = inventoryResultForNotification.changeVersions.get(productId);
        if (changeVersion) {
          try {
            this.notifications.emitCatalogItemsUpdated({
              productId,
              action: 'UPSERT',
              changeVersion,
              currentVersion: inventoryResultForNotification.currentVersion,
            });
          } catch {
            // Não derruba a request por falha de notificação
          }
        }
      }
    }

    return result;
  }

  /**
   * POST /orders/:id/confirm
   * Sempre revalida antes de confirmar.
   */
  async confirmOrder(
    orderId: string,
    input: ConfirmOrderDto,
  ): Promise<CreateOrderResponseDto> {
    const dto = ConfirmOrderSchema.parse(input ?? {});
    const emitted: OrderEventMessage[] = [];
    let inventoryResultForNotification:
      | {
          affectedProductIds: string[];
          changeVersions: Map<string, number>;
          currentVersion: number;
        }
      | undefined;

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!order) throw new NotFoundException('Order not found');
      if (order.status === OrderStatus.CANCELLED)
        throw new ConflictException('Order is cancelled');

      if (order.status === OrderStatus.CONFIRMED) {
        return {
          orderId: order.id,
          status: order.status,
          currency: order.currency,
          totalCents: order.totalCents,
          diffs: [],
          items: order.items.map((it) => ({
            productId: it.productId,
            qty: it.qty,
            clientPriceCents: it.clientPriceCents,
            serverPriceCents: it.serverPriceCents ?? null,
            productNameSnapshot: it.productNameSnapshot ?? null,
            productSkuSnapshot: it.productSkuSnapshot ?? null,
            productImageSnapshot: it.productImageSnapshot ?? null,
          })),
        };
      }

      if (
        dto.expectedTotalCents !== undefined &&
        dto.expectedTotalCents !== order.totalCents
      ) {
        throw new BadRequestException(
          'expectedTotalCents does not match current total',
        );
      }

      const productIds = Array.from(
        new Set(order.items.map((i) => i.productId)),
      );
      const productsById = await this.loadProductsMap(tx, productIds);

      const { diffs, totalCents, itemViews } = this.repriceLines({
        items: order.items.map((i) => ({
          productId: i.productId,
          qty: i.qty,
          clientPriceCents: i.clientPriceCents,
          previousServerPriceCents: i.serverPriceCents,
        })),
        productsById,
        mode: 'CONFIRM',
      });

      // atualiza itens com novo serverPriceCents + snapshots
      for (const it of order.items) {
        const v = itemViews.find((x) => x.productId === it.productId);
        if (!v) continue;

        await tx.orderItem.update({
          where: { id: it.id },
          data: {
            serverPriceCents: v.serverPriceCents,
            productNameSnapshot: v.productNameSnapshot ?? null,
            productSkuSnapshot: v.productSkuSnapshot ?? null,
            productImageSnapshot: v.productImageSnapshot ?? null,
          },
        });
      }

      const hasHardBlock = diffs.some(
        (d) =>
          d.kind === 'NOT_FOUND' ||
          d.kind === 'DELETED' ||
          d.kind === 'OUT_OF_STOCK',
      );
      const hasPrice = diffs.some((d) => d.kind === 'PRICE_CHANGED');

      if (hasHardBlock || hasPrice) {
        const status = hasHardBlock
          ? OrderStatus.REJECTED
          : OrderStatus.REQUIRES_CONFIRMATION;

        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status, totalCents },
          select: { id: true, status: true, totalCents: true, currency: true },
        });

        emitted.push(
          await this.createEvent(tx, order.id, OrderEventType.ORDER_VALIDATED, {
            status,
            totalCents,
            diffs,
          }),
        );

        const priceDiffs = diffs.filter((d) => d.kind === 'PRICE_CHANGED');
        if (priceDiffs.length > 0) {
          emitted.push(
            await this.createEvent(tx, order.id, OrderEventType.PRICE_CHANGED, {
              diffs: priceDiffs,
            }),
          );
        }

        if (status === OrderStatus.REJECTED) {
          emitted.push(
            await this.createEvent(
              tx,
              order.id,
              OrderEventType.ORDER_REJECTED,
              {
                diffs,
              },
            ),
          );
        }

        return {
          orderId: updated.id,
          status: updated.status,
          currency: updated.currency,
          totalCents: updated.totalCents,
          diffs,
          items: itemViews,
        };
      }

      // ✅ Decrementa estoque de forma segura e cria ProductChange
      const inventoryResult = await this.decrementInventoryAndEmitChange(
        tx,
        order.items.map((it) => ({ productId: it.productId, qty: it.qty })),
        productsById,
      );

      // Se houver erros de estoque, rejeita o pedido
      if (inventoryResult.stockErrors.length > 0) {
        const status = OrderStatus.REJECTED;
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { status, totalCents },
          select: { id: true, status: true, totalCents: true, currency: true },
        });

        emitted.push(
          await this.createEvent(tx, order.id, OrderEventType.ORDER_VALIDATED, {
            status,
            totalCents,
            diffs: inventoryResult.stockErrors,
          }),
        );

        emitted.push(
          await this.createEvent(tx, order.id, OrderEventType.ORDER_REJECTED, {
            diffs: inventoryResult.stockErrors,
          }),
        );

        return {
          orderId: updated.id,
          status: updated.status,
          currency: updated.currency,
          totalCents: updated.totalCents,
          diffs: inventoryResult.stockErrors,
          items: itemViews,
        };
      }

      const confirmed = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CONFIRMED, totalCents },
        select: { id: true, status: true, totalCents: true, currency: true },
      });

      emitted.push(
        await this.createEvent(tx, order.id, OrderEventType.ORDER_CONFIRMED, {
          totalCents: confirmed.totalCents,
        }),
      );

      // Armazena informações para notificação após commit (fora da transação)
      inventoryResultForNotification = {
        affectedProductIds: inventoryResult.affectedProductIds,
        changeVersions: inventoryResult.changeVersions,
        currentVersion: inventoryResult.currentVersion,
      };

      return {
        orderId: confirmed.id,
        status: confirmed.status,
        currency: confirmed.currency,
        totalCents: confirmed.totalCents,
        diffs: [],
        items: itemViews,
      };
    });

    // ✅ Publica eventos após commit
    for (const ev of emitted) this.orderEvents.publish(ev);

    // ✅ Emite notificações de mudança de catálogo após commit
    if (inventoryResultForNotification && inventoryResultForNotification.affectedProductIds.length > 0) {
      for (const productId of inventoryResultForNotification.affectedProductIds) {
        const changeVersion = inventoryResultForNotification.changeVersions.get(productId);
        if (changeVersion) {
          try {
            this.notifications.emitCatalogItemsUpdated({
              productId,
              action: 'UPSERT',
              changeVersion,
              currentVersion: inventoryResultForNotification.currentVersion,
            });
          } catch {
            // Não derruba a request por falha de notificação
          }
        }
      }
    }

    return result;
  }

  /**
   * GET /orders/:id
   */
  async getOrder(orderId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        events: { orderBy: { createdAt: 'asc' }, take: 50 },
      },
    });

    if (!order) throw new NotFoundException('Order not found');

    return {
      orderId: order.id,
      status: order.status,
      currency: order.currency,
      totalCents: order.totalCents,
      clientCatalogVersion: order.clientCatalogVersion,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      items: order.items.map((it) => ({
        id: it.id,
        productId: it.productId,
        qty: it.qty,
        clientPriceCents: it.clientPriceCents,
        serverPriceCents: it.serverPriceCents ?? null,
        productNameSnapshot: it.productNameSnapshot ?? null,
        productSkuSnapshot: it.productSkuSnapshot ?? null,
        productImageSnapshot: it.productImageSnapshot ?? null,
      })),
      events: order.events.map((ev) => {
        // Serializa o payload corretamente (Prisma retorna JsonValue)
        let payload: unknown = null;
        if (ev.payload != null) {
          // Prisma JsonValue pode ser string, number, boolean, object, array, etc.
          // JSON.parse/stringify garante serialização correta
          try {
            payload = typeof ev.payload === 'string' 
              ? JSON.parse(ev.payload) 
              : ev.payload;
          } catch {
            payload = ev.payload;
          }
        }

        return {
          id: ev.id,
          type: ev.type,
          payload,
          createdAt: ev.createdAt.toISOString(),
        };
      }),
    };
  }

  // ✅ LISTAGEM
  async listOrders(q: OrdersListQueryDto) {
    const dto = OrdersListQuerySchema.parse(q);
    const take = dto.limit ?? 20;

    const rows = await this.prisma.order.findMany({
      where: dto.status ? { status: dto.status } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        totalCents: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true } },
      },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      items: page.map((r) => ({
        orderId: r.id,
        status: r.status,
        totalCents: r.totalCents,
        currency: r.currency,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        itemsCount: r._count.items,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  // ✅ CANCELAR (descartar carrinho)
  async cancelOrder(orderId: string) {
    const emitted: OrderEventMessage[] = [];

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');

      if (order.status === OrderStatus.CONFIRMED) {
        throw new ConflictException('Cannot cancel a confirmed order');
      }
      if (order.status === OrderStatus.CANCELLED) {
        return { orderId: order.id, status: order.status };
      }

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED },
        select: { id: true, status: true },
      });

      emitted.push(
        await this.createEvent(tx, order.id, OrderEventType.ORDER_CANCELLED),
      );

      return { orderId: updated.id, status: updated.status };
    });

    for (const ev of emitted) this.orderEvents.publish(ev);

    // ✅ notifica via WS
    this.notifications.emitOrderCancelled({ orderId: result.orderId });

    return result;
  }

  // ✅ no final do createOrder (depois do commit), adicione:
  // - CONFIRMED => notificação
  // - REQUIRES_CONFIRMATION => notificação com diffs
  // - REJECTED => notificação
  //
  // Dentro do seu createOrder(), depois do loop publish(ev):
  //   this.emitOrderNotifications(result)
  //
  private emitOrderNotifications(result: {
    orderId: string;
    status: OrderStatus;
    totalCents: number;
    currency: Currency;
    diffs: unknown[];
  }) {
    if (result.status === OrderStatus.CONFIRMED) {
      this.notifications.emitOrderConfirmed({
        orderId: result.orderId,
        totalCents: result.totalCents,
        currency: result.currency,
      });
      return;
    }

    if (result.status === OrderStatus.REQUIRES_CONFIRMATION) {
      this.notifications.emitOrderRequiresConfirmation({
        orderId: result.orderId,
        totalCents: result.totalCents,
        currency: result.currency,
        diffs: result.diffs,
      });
      return;
    }

    if (result.status === OrderStatus.REJECTED) {
      this.notifications.emitOrderRejected({
        orderId: result.orderId,
        diffs: result.diffs,
      });
    }
  }
}
