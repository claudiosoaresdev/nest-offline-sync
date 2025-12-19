import { createZodDto } from 'nestjs-zod';
import { CatalogChangeType } from 'src/generated/prisma/enums';
import { z } from 'zod';

import { ProductSchema } from './product.schema';

const CatalogUpsertChangeSchema = z.object({
  type: z.literal('UPSERT' as CatalogChangeType),
  version: z.number().int().min(1),
  productId: z.uuid(),
  product: ProductSchema,
});

const CatalogDeleteChangeSchema = z.object({
  type: z.literal('DELETE' as CatalogChangeType),
  version: z.number().int().min(1),
  productId: z.uuid(),
});

export const CatalogChangeSchema = z.discriminatedUnion('type', [
  CatalogUpsertChangeSchema,
  CatalogDeleteChangeSchema,
]);

export const CatalogChangesResponseSchema = z.object({
  currentVersion: z.number().int().min(0),
  changes: z.array(CatalogChangeSchema),
});

export type CatalogChangeDto = z.infer<typeof CatalogChangeSchema>;
export class CatalogChangesResponseDto extends createZodDto(
  CatalogChangesResponseSchema,
) {}
