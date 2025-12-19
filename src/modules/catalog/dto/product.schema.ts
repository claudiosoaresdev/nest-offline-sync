import { createZodDto } from 'nestjs-zod';
import { Currency } from 'src/generated/prisma/client';
import { z } from 'zod';

export const ProductSchema = z.object({
  id: z.uuid(),
  sku: z.string().nullable().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  imageUrl: z.url().nullable().optional(),

  priceCents: z.number().int().min(0),
  currency: z.enum(Currency),

  // opcional (se quiser expor no catálogo)
  stockOnHand: z.number().int().min(0).optional(),
});

export class ProductDto extends createZodDto(ProductSchema) {}
