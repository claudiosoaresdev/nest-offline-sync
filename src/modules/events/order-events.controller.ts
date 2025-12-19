import type { MessageEvent } from '@nestjs/common';
import { Controller, Headers, Param, Query, Sse } from '@nestjs/common';
import { concat, from, map, mergeMap, Observable } from 'rxjs';
import { ZodValidationPipe } from 'src/common/pipes/zod-validation.pipe';
import { z } from 'zod';

import { OrderEventsService } from './order-events.service';

const uuidParamPipe = new ZodValidationPipe(z.string().uuid());

const sseQuerySchema = z.object({
  // opcional: replay a partir de um instante
  since: z.string().datetime().optional(),
  // opcional: limita replay
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
type SseQuery = z.infer<typeof sseQuerySchema>;
const sseQueryPipe = new ZodValidationPipe(sseQuerySchema);

@Controller('orders')
export class OrderEventsController {
  constructor(private readonly events: OrderEventsService) {}

  /**
   * SSE: GET /orders/:id/events
   *
   * - Ao conectar: faz replay dos eventos recentes do banco (OrderEvent)
   * - Enquanto conectado: recebe eventos novos (in-memory publish)
   *
   * Reconnect padrão do browser:
   * - EventSource envia header "Last-Event-ID" automaticamente (se você setar "id" no SSE)
   */
  @Sse(':id/events')
  stream(
    @Param('id', uuidParamPipe) id: string,
    @Query(sseQueryPipe) q: SseQuery,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    const replay$ = from(
      this.events.replay({
        orderId: id,
        limit: q.limit,
        sinceIso: q.since,
        lastEventId,
      }),
    ).pipe(
      mergeMap((arr) => from(arr)),
      map((ev) => ({
        id: ev.id,
        type: ev.type, // vira "event:" no SSE
        data: ev,
      })),
    );

    const live$ = this.events.live(id).pipe(
      map((ev) => ({
        id: ev.id,
        type: ev.type,
        data: ev,
      })),
    );

    // replay primeiro, depois stream ao vivo
    return concat(replay$, live$);
  }
}
