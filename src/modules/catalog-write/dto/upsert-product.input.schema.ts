import { createZodDto } from 'nestjs-zod';
import { Currency } from 'src/generated/prisma/client';
import { z } from 'zod';

export const UpsertProductInputSchema = z.object({
  /**
   * Se vier, tenta upsert por ID (UUID).
   * Se não vier, podemos tentar por SKU (se vier).
   */
  id: z.uuid().optional(),

  /**
   * SKU é unique no seu schema, mas é opcional/nullable.
   * Se vier null/undefined, ok.
   */
  sku: z.string().min(1).nullable().optional(),

  name: z.string().min(1),
  description: z.string().nullable().optional(),
  imageUrl: z.url().nullable().optional(),

  priceCents: z.number().int().min(0),
  currency: z.enum(Currency).optional(),

  stockOnHand: z.number().int().min(0).optional(),

  /**
   * Se true, grava payload no ProductChange (bom p/ debug).
   * Em produção, você pode desligar para reduzir escrita.
   */
  emitPayload: z.boolean().optional(),
});

export class UpsertProductInputDto extends createZodDto(
  UpsertProductInputSchema,
) {}
