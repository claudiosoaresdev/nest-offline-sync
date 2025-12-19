import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const OrderDiffKindSchema = z.enum([
  'PRICE_CHANGED',
  'NOT_FOUND',
  'DELETED',
  'OUT_OF_STOCK',
]);

export type OrderDiffKind = z.infer<typeof OrderDiffKindSchema>;

/**
 * Diferença/alerta retornado ao cliente antes de confirmar.
 * Pode ser usado para:
 * - avisar que o preço mudou
 * - produto não existe / foi deletado
 * - sem estoque suficiente
 */
export const OrderDiffSchema = z.object({
  productId: z.string().uuid(),
  kind: OrderDiffKindSchema,

  // preço visto pelo cliente (offline)
  clientPriceCents: z.number().int().min(0).optional(),

  // preço atual calculado no servidor
  serverPriceCents: z.number().int().min(0).optional(),

  // preço do servidor na validação anterior (útil em /confirm quando o preço muda de novo)
  previousServerPriceCents: z.number().int().min(0).optional(),

  // estoque observado no momento da validação
  stockOnHand: z.number().int().min(0).optional(),

  // texto opcional para UI
  message: z.string().optional(),
});

export class OrderDiffDto extends createZodDto(OrderDiffSchema) {}
