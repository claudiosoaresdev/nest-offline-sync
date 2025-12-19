import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

/**
 * Paginação DESC (mais novo -> mais antigo):
 * - sinceVersion: limite inferior (version > sinceVersion)
 * - beforeVersion: cursor para buscar mais antigo (version < beforeVersion)
 */
export const CatalogHistoryQuerySchema = z.object({
  sinceVersion: emptyToUndefined(z.coerce.number().int().min(0)).default(0),

  // cursor (exclusivo): pega versões < beforeVersion
  beforeVersion: emptyToUndefined(z.coerce.number().int().min(1)).optional(),

  limit: emptyToUndefined(z.coerce.number().int().min(1).max(5000)).default(
    500,
  ),
});

export class CatalogHistoryQueryDto extends createZodDto(
  CatalogHistoryQuerySchema,
) {}
