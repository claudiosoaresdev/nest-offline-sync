import { createZodDto } from 'nestjs-zod';
import { Currency, OrderStatus } from 'src/generated/prisma/client';
import { OrderDiffSchema } from 'src/modules/orders/dto/order-diff.schema';
import { z } from 'zod';

export const OrderItemViewSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(1),

  clientPriceCents: z.number().int().min(0),
  serverPriceCents: z.number().int().min(0).nullable(),

  // snapshots (pra UI do pedido continuar legível)
  productNameSnapshot: z.string().nullable().optional(),
  productSkuSnapshot: z.string().nullable().optional(),
  productImageSnapshot: z.string().nullable().optional(),
});

export const CreateOrderResponseSchema = z.object({
  orderId: z.string().uuid(),
  status: z.nativeEnum(OrderStatus),

  currency: z.nativeEnum(Currency),
  totalCents: z.number().int().min(0),

  diffs: z.array(OrderDiffSchema),

  // útil pro frontend já atualizar a UI com o “server truth”
  items: z.array(OrderItemViewSchema),
});

export class CreateOrderResponseDto extends createZodDto(
  CreateOrderResponseSchema,
) {}
