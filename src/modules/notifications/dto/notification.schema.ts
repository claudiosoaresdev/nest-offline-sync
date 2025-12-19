import { z } from 'zod';

export const NotificationTypeSchema = z.enum([
  'REMINDER',
  'INFO',
  'ACHIEVEMENT',
  'CATALOG_ITEMS_UPDATED',

  // ✅ novos
  'ORDER_CONFIRMED',
  'ORDER_REQUIRES_CONFIRMATION',
  'ORDER_REJECTED',
  'ORDER_CANCELLED',
]);

export const CatalogItemsUpdatedDataSchema = z.object({
  productId: z.string().uuid(),
  action: z.enum(['UPSERT', 'DELETE']),
  changeVersion: z.number().int().min(1),
  currentVersion: z.number().int().min(0),
});

// ✅ novos payloads (simples e úteis)
export const OrderConfirmedDataSchema = z.object({
  orderId: z.string().uuid(),
  totalCents: z.number().int().min(0),
  currency: z.string().min(1),
});

export const OrderRequiresConfirmationDataSchema = z.object({
  orderId: z.string().uuid(),
  totalCents: z.number().int().min(0),
  currency: z.string().min(1),
  diffs: z.array(z.unknown()), // (você pode tipar com OrderDiffSchema se quiser)
});

export const OrderRejectedDataSchema = z.object({
  orderId: z.string().uuid(),
  diffs: z.array(z.unknown()).optional(),
});

export const OrderCancelledDataSchema = z.object({
  orderId: z.string().uuid(),
});

// ✅ "no record": objeto livre com chaves dinâmicas
const FreeJsonObjectSchema = z.object({}).catchall(z.unknown());

export const NotificationMessageSchema = z.object({
  id: z.string().uuid(),
  type: NotificationTypeSchema,
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  at: z.string().datetime(),

  data: z
    .union([
      CatalogItemsUpdatedDataSchema,
      OrderConfirmedDataSchema,
      OrderRequiresConfirmationDataSchema,
      OrderRejectedDataSchema,
      OrderCancelledDataSchema,
      FreeJsonObjectSchema,
    ])
    .optional(),
});
