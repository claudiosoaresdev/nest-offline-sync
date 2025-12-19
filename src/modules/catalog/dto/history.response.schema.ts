import { createZodDto } from 'nestjs-zod';
import { CatalogChangeType } from 'src/generated/prisma/enums';
import { z } from 'zod';

import { ProductSchema } from './product.schema';

const IsoDateTime = z.string().datetime();

// garante stockOnHand obrigatório no history (client já espera sempre number)
const ProductHistorySchema = ProductSchema.extend({
  stockOnHand: z.number().int().min(0),
});

const CatalogHistoryUpsertChangeSchema = z.object({
  type: z.literal('UPSERT' as CatalogChangeType),
  version: z.number().int().min(1),
  at: IsoDateTime,
  productId: z.uuid(),
  product: ProductHistorySchema,
});

const CatalogHistoryDeleteChangeSchema = z.object({
  type: z.literal('DELETE' as CatalogChangeType),
  version: z.number().int().min(1),
  at: IsoDateTime,
  productId: z.uuid(),
  deletedAt: IsoDateTime.optional(),
  // opcional (se vier snapshot/payload ou produto ainda existir)
  product: ProductHistorySchema.optional(),
});

export const CatalogHistoryChangeSchema = z.discriminatedUnion('type', [
  CatalogHistoryUpsertChangeSchema,
  CatalogHistoryDeleteChangeSchema,
]);

export const CatalogHistoryResponseSchema = z.object({
  currentVersion: z.number().int().min(0),
  changes: z.array(CatalogHistoryChangeSchema),
  totalItems: z.number().int().min(0).optional(),

  hasMore: z.boolean(),
  nextBeforeVersion: z.number().int().min(1).optional(),
});

export type CatalogHistoryChangeDto = z.infer<
  typeof CatalogHistoryChangeSchema
>;
export class CatalogHistoryResponseDto extends createZodDto(
  CatalogHistoryResponseSchema,
) {}
