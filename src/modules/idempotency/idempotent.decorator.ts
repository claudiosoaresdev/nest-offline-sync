import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotency:enabled';

/**
 * Use em rotas que você quer habilitar idempotência via header Idempotency-Key.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
