import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

// aceita "1", "true", "on"
export const coerceBool = z.preprocess((v) => {
  // trate ausência/valor vazio como "false" (ou mude pra undefined se preferir 400)
  if (v === undefined || v === null || v === '') return false;

  if (typeof v === 'boolean') return v;

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(s)) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
    return v; // mantém pra falhar no z.boolean() se vier algo inválido
  }

  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
    return v; // inválido -> falha
  }

  return v; // inválido -> falha
}, z.boolean());

export const CatalogSnapshotQuerySchema = z.object({
  limit: emptyToUndefined(z.coerce.number().int().min(1).max(1000)).default(
    200,
  ),
  cursor: emptyToUndefined(z.uuid()).optional(),

  // só a 1ª página costuma pedir isso, pra iniciar a barra
  withTotal: emptyToUndefined(coerceBool).default(false),
});

export class CatalogSnapshotQueryDto extends createZodDto(
  CatalogSnapshotQuerySchema,
) {}
