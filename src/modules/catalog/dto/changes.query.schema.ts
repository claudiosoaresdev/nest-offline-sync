import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

export const CatalogChangesQuerySchema = z.object({
  sinceVersion: emptyToUndefined(z.coerce.number().int().min(0)),
  limit: emptyToUndefined(z.coerce.number().int().min(1).max(5000)).default(
    500,
  ),
});

export class CatalogChangesQueryDto extends createZodDto(
  CatalogChangesQuerySchema,
) {}
