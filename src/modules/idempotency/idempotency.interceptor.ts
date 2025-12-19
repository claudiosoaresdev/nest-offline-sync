import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  catchError,
  from,
  map,
  mergeMap,
  Observable,
  of,
  throwError,
} from 'rxjs';
import { Prisma } from 'src/generated/prisma/client';

import { IdempotencyService } from './idempotency.service';
import { IDEMPOTENT_KEY } from './idempotent.decorator';

type Req = Request & {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  baseUrl?: string;
  body?: unknown;
};

type ExpressLikeRes = {
  statusCode?: number;
  status?: (code: number) => any;
};

type FastifyLikeRes = {
  statusCode?: number;
  code?: (code: number) => any;
};

function setHttpStatus(res: unknown, status: number) {
  const r = res as ExpressLikeRes & FastifyLikeRes;

  // Express: res.status(200)
  if (typeof r.status === 'function') {
    r.status(status);
    return;
  }

  // Fastify: reply.code(200)
  if (typeof r.code === 'function') {
    r.code(status);
    return;
  }

  // fallback
  r.statusCode = status;
}

/**
 * Converte qualquer coisa em Prisma.JsonValue (JSON-safe).
 * - undefined -> null
 * - Date -> ISO string
 * - BigInt -> string
 * - remove funções/symbols (vira null)
 * - recursivo em arrays/objetos
 */
function toJsonValue(value: unknown): Prisma.JsonValue {
  if (value === undefined || value === null) return null;

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString(); // ✅ sem warning
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) return value.map(toJsonValue);

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, Prisma.JsonValue> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toJsonValue(v);
    return out;
  }

  return null;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idem: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!enabled) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<unknown>();

    // Header padrão: Idempotency-Key
    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Se não veio key, segue normal (você pode trocar por 400 se quiser obrigar)
    if (!key || key.trim().length === 0) {
      return next.handle();
    }

    const method = (req.method || 'POST').toUpperCase();

    // path normalizado (sem query)
    const fullUrl = req.originalUrl ?? req.url ?? '';
    const pathOnly =
      (fullUrl.split('?')[0] || '').trim() ||
      `${req.baseUrl ?? ''}${req.path ?? ''}`;

    // Hash do request (opcional, mas recomendado)
    const bodyJson = toJsonValue(req.body ?? null);
    const requestHash = this.idem.computeRequestHash(
      method,
      pathOnly,
      bodyJson,
    );

    return from(this.idem.findValid(key)).pipe(
      mergeMap((found) => {
        // 1) Key existe e já tem resposta -> replay
        if (found && found.responseStatus !== null) {
          this.idem.assertSameHashOrThrow(found.requestHash, requestHash);

          setHttpStatus(res, found.responseStatus);

          // found.responseBody já é Prisma.JsonValue | null
          return of(found.responseBody ?? {});
        }

        // 2) Key existe mas ainda não tem resposta -> em processamento
        if (found && found.responseStatus === null) {
          this.idem.assertSameHashOrThrow(found.requestHash, requestHash);
          return throwError(
            () =>
              new ConflictException(
                'Request with this Idempotency-Key is being processed',
              ),
          );
        }

        // 3) Não existe -> cria pendente e executa handler
        return from(
          this.idem.createPending({
            key,
            requestHash,
            method,
            path: pathOnly,
          }),
        ).pipe(
          mergeMap(() =>
            next.handle().pipe(
              // sucesso: grava resposta e repassa
              mergeMap((body) => {
                const status =
                  (res as any)?.statusCode &&
                  Number.isFinite((res as any).statusCode)
                    ? (res as any).statusCode
                    : 200;

                // só cacheia status < 500 (evita congelar falhas de infra)
                if (status < 500) {
                  const jsonBody = toJsonValue(body);

                  return from(
                    this.idem.saveResponse({
                      key,
                      requestHash,
                      status,
                      body: jsonBody,
                      method,
                      path: pathOnly,
                    }),
                  ).pipe(map(() => body));
                }

                return of(body);
              }),

              // erro: se HttpException < 500, salva também (útil pra retries offline)
              catchError((err: unknown) => {
                if (err instanceof HttpException) {
                  const status = err.getStatus();

                  if (status < 500) {
                    const resp = err.getResponse();
                    const jsonBody = toJsonValue(resp);

                    return from(
                      this.idem.saveResponse({
                        key,
                        requestHash,
                        status,
                        body: jsonBody,
                        method,
                        path: pathOnly,
                      }),
                    ).pipe(mergeMap(() => throwError(() => err)));
                  }
                }

                return throwError(() => err);
              }),
            ),
          ),
        );
      }),
    );
  }
}
