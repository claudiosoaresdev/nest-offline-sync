import { createZodDto } from 'nestjs-zod';
import {
  Currency,
  OrderEventType,
  OrderStatus,
} from 'src/generated/prisma/client';
import { z } from 'zod';

export const OrderItemSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  qty: z.number().int().min(1),

  clientPriceCents: z.number().int().min(0),
  serverPriceCents: z.number().int().min(0).nullable(),

  productNameSnapshot: z.string().nullable().optional(),
  productSkuSnapshot: z.string().nullable().optional(),
  productImageSnapshot: z.string().nullable().optional(),
});

export const OrderEventSchema = z.object({
  id: z.uuid(),
  type: z.enum(OrderEventType),
  payload: z.unknown().optional(),
  createdAt: z.string(), // ISO
});

export const OrderSchema = z.object({
  orderId: z.uuid(),
  status: z.enum(OrderStatus),
  currency: z.enum(Currency),
  totalCents: z.number().int().min(0),
  clientCatalogVersion: z.number().int().min(0),

  createdAt: z.string(),
  updatedAt: z.string(),

  items: z.array(OrderItemSchema),
  events: z.array(OrderEventSchema),
});

export class OrderDto extends createZodDto(OrderSchema) {}
