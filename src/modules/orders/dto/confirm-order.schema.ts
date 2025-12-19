import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Body opcional (você pode manter vazio).
 * Eu gosto de aceitar um "expectedTotalCents" pra proteger contra UI desatualizada,
 * mas o confirm também revalida no servidor, então é opcional mesmo.
 */
export const ConfirmOrderSchema = z.object({
  expectedTotalCents: z.number().int().min(0).optional(),
});

export class ConfirmOrderDto extends createZodDto(ConfirmOrderSchema) {}
