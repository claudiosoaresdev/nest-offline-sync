import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Server } from 'socket.io';
import {
  CatalogItemsUpdatedDataSchema,
  NotificationMessageSchema,
  NotificationTypeSchema,
  OrderCancelledDataSchema,
  OrderConfirmedDataSchema,
  OrderRejectedDataSchema,
  OrderRequiresConfirmationDataSchema,
} from 'src/modules/notifications/dto/notification.schema';
import { z } from 'zod';

const MAX_BUFFER = 100;
const NotificationMessageArraySchema = z.array(NotificationMessageSchema);

@Injectable()
export class NotificationsService {
  private server: Server | null = null;
  private buffer: unknown[] = [];

  setServer(server: Server) {
    this.server = server;
  }

  listLatest(limit = 25) {
    const safeLimit = Math.max(0, Math.floor(limit));
    const parsed = NotificationMessageArraySchema.parse(this.buffer);
    return parsed.slice(0, safeLimit);
  }

  private findById(id: string) {
    for (const item of this.buffer) {
      const parsed = NotificationMessageSchema.safeParse(item);
      if (parsed.success && parsed.data.id === id) return parsed.data;
    }
    return null;
  }

  private findCatalogByChangeVersion(changeVersion: number) {
    for (const item of this.buffer) {
      const msgParsed = NotificationMessageSchema.safeParse(item);
      if (!msgParsed.success) continue;

      const msg = msgParsed.data;
      if (msg.type !== NotificationTypeSchema.enum.CATALOG_ITEMS_UPDATED)
        continue;

      const dataParsed = CatalogItemsUpdatedDataSchema.safeParse(msg.data);
      if (!dataParsed.success) continue;

      if (dataParsed.data.changeVersion === changeVersion) return msg;
    }
    return null;
  }

  // ✅ dedupe por pedido
  private findOrderNotification(
    orderId: string,
    type: z.infer<typeof NotificationTypeSchema>,
  ) {
    for (const item of this.buffer) {
      const msgParsed = NotificationMessageSchema.safeParse(item);
      if (!msgParsed.success) continue;

      const msg = msgParsed.data;
      if (msg.type !== type) continue;

      const data = msg.data;
      if (type === NotificationTypeSchema.enum.ORDER_CONFIRMED) {
        const p = OrderConfirmedDataSchema.safeParse(data);
        if (p.success && p.data.orderId === orderId) return msg;
      }
      if (type === NotificationTypeSchema.enum.ORDER_REQUIRES_CONFIRMATION) {
        const p = OrderRequiresConfirmationDataSchema.safeParse(data);
        if (p.success && p.data.orderId === orderId) return msg;
      }
      if (type === NotificationTypeSchema.enum.ORDER_REJECTED) {
        const p = OrderRejectedDataSchema.safeParse(data);
        if (p.success && p.data.orderId === orderId) return msg;
      }
      if (type === NotificationTypeSchema.enum.ORDER_CANCELLED) {
        const p = OrderCancelledDataSchema.safeParse(data);
        if (p.success && p.data.orderId === orderId) return msg;
      }
    }
    return null;
  }

  emit(raw: unknown) {
    const msg = NotificationMessageSchema.parse(raw);

    const existing = this.findById(msg.id);
    if (existing) return existing;

    this.buffer = [msg, ...this.buffer].slice(0, MAX_BUFFER);
    this.server?.emit('notification', msg);

    return msg;
  }

  emitCatalogItemsUpdated(raw: unknown) {
    const data = CatalogItemsUpdatedDataSchema.parse(raw);

    const existing = this.findCatalogByChangeVersion(data.changeVersion);
    if (existing) return existing;

    return this.emit({
      id: randomUUID(),
      type: NotificationTypeSchema.enum.CATALOG_ITEMS_UPDATED,
      title: 'Novos itens atualizados',
      description: `Ação: ${data.action} • Produto: ${data.productId} • Versão: ${data.currentVersion}`,
      at: new Date().toISOString(),
      data,
    });
  }

  // ✅ novos
  emitOrderConfirmed(raw: unknown) {
    const data = OrderConfirmedDataSchema.parse(raw);
    const existing = this.findOrderNotification(
      data.orderId,
      NotificationTypeSchema.enum.ORDER_CONFIRMED,
    );
    if (existing) return existing;

    return this.emit({
      id: randomUUID(),
      type: NotificationTypeSchema.enum.ORDER_CONFIRMED,
      title: 'Pedido confirmado',
      description: `Pedido ${data.orderId} confirmado.`,
      at: new Date().toISOString(),
      data,
    });
  }

  emitOrderRequiresConfirmation(raw: unknown) {
    const data = OrderRequiresConfirmationDataSchema.parse(raw);
    const existing = this.findOrderNotification(
      data.orderId,
      NotificationTypeSchema.enum.ORDER_REQUIRES_CONFIRMATION,
    );
    if (existing) return existing;

    return this.emit({
      id: randomUUID(),
      type: NotificationTypeSchema.enum.ORDER_REQUIRES_CONFIRMATION,
      title: 'Confirmação necessária',
      description: `Pedido ${data.orderId} precisa de confirmação (preço/estoque mudou).`,
      at: new Date().toISOString(),
      data,
    });
  }

  emitOrderRejected(raw: unknown) {
    const data = OrderRejectedDataSchema.parse(raw);
    const existing = this.findOrderNotification(
      data.orderId,
      NotificationTypeSchema.enum.ORDER_REJECTED,
    );
    if (existing) return existing;

    return this.emit({
      id: randomUUID(),
      type: NotificationTypeSchema.enum.ORDER_REJECTED,
      title: 'Pedido rejeitado',
      description: `Pedido ${data.orderId} foi rejeitado.`,
      at: new Date().toISOString(),
      data,
    });
  }

  emitOrderCancelled(raw: unknown) {
    const data = OrderCancelledDataSchema.parse(raw);
    const existing = this.findOrderNotification(
      data.orderId,
      NotificationTypeSchema.enum.ORDER_CANCELLED,
    );
    if (existing) return existing;

    return this.emit({
      id: randomUUID(),
      type: NotificationTypeSchema.enum.ORDER_CANCELLED,
      title: 'Pedido cancelado',
      description: `Pedido ${data.orderId} foi cancelado.`,
      at: new Date().toISOString(),
      data,
    });
  }
}
