import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateOrderItemSchema = z.object({
  productId: z.string().uuid(),
  qty: z.coerce.number().int().min(1).max(999),
  clientPriceCents: z.coerce.number().int().min(0),
});

export const CreateOrderSchema = z.object({
  // versão do catálogo do cliente quando ele montou o pedido
  clientCatalogVersion: z.coerce.number().int().min(0),

  /**
   * opcional: id do request do cliente p/ dedupe.
   * bom para offline queue (retries) sem criar pedidos duplicados.
   */
  clientRequestId: z.string().min(1).optional(),

  // limite de itens por pedido (ajuste como quiser)
  items: z.array(CreateOrderItemSchema).min(1).max(100),
});

export class CreateOrderDto extends createZodDto(CreateOrderSchema) {}
