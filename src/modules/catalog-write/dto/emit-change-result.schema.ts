import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const EmitChangeResultSchema = z.object({
  productId: z.uuid(),
  changeVersion: z.number().int().min(1),
  currentVersion: z.number().int().min(0),
});

export class EmitChangeResultDto extends createZodDto(EmitChangeResultSchema) {}
