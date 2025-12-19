import { createZodDto } from 'nestjs-zod';
import { Currency, OrderStatus } from 'src/generated/prisma/client';
import { z } from 'zod';

export const OrdersListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().uuid().optional(), // cursor por id
  status: z.nativeEnum(OrderStatus).optional(),
});
export class OrdersListQueryDto extends createZodDto(OrdersListQuerySchema) {}

export const OrdersListItemSchema = z.object({
  orderId: z.string().uuid(),
  status: z.nativeEnum(OrderStatus),
  totalCents: z.number().int().min(0),
  currency: z.nativeEnum(Currency),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  itemsCount: z.number().int().min(0),
});
export const OrdersListResponseSchema = z.object({
  items: z.array(OrdersListItemSchema),
  nextCursor: z.string().uuid().nullable(),
});
export class OrdersListResponseDto extends createZodDto(
  OrdersListResponseSchema,
) {}
