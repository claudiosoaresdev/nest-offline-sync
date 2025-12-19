import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ProductSchema } from './product.schema';

export const CatalogSnapshotResponseSchema = z.object({
  currentVersion: z.number().int().min(0),
  totalItems: z.number().int().min(0).optional(),
  items: z.array(ProductSchema),
  nextCursor: z.uuid().optional(),
  hasMore: z.boolean().optional(),
});

export class CatalogSnapshotResponseDto extends createZodDto(
  CatalogSnapshotResponseSchema,
) {}
