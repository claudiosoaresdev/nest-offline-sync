import { Injectable } from '@nestjs/common';
import { finalize, interval, map, merge, Observable, Subject } from 'rxjs';
import { OrderEventType, Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';

export type OrderEventMessage = {
  id: string;
  orderId: string;
  type: OrderEventType | 'PING';
  payload: Prisma.JsonValue | null;
  createdAt: string; // ISO
};

type StreamEntry = {
  subject: Subject<OrderEventMessage>;
  subscribers: number;
};

@Injectable()
export class OrderEventsService {
  private readonly streams = new Map<string, StreamEntry>();

  constructor(private readonly prisma: PrismaService) {}

  private getOrCreate(orderId: string): StreamEntry {
    const existing = this.streams.get(orderId);
    if (existing) return existing;

    const created: StreamEntry = {
      subject: new Subject<OrderEventMessage>(),
      subscribers: 0,
    };
    this.streams.set(orderId, created);
    return created;
  }

  /**
   * Stream ao vivo (in-memory). Funciona bem em 1 instância.
   * Em produção multi-instância, você trocaria isso por Redis PubSub / Kafka / NATS etc.
   */
  live(orderId: string): Observable<OrderEventMessage> {
    const entry = this.getOrCreate(orderId);
    entry.subscribers++;

    // keepalive ping (evita proxy fechar SSE por “inatividade”)
    const ping$ = interval(15_000).pipe(
      map(
        (): OrderEventMessage => ({
          id: `ping-${Date.now()}`,
          orderId,
          type: 'PING',
          payload: { ts: new Date().toISOString() },
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    const live$ = entry.subject.asObservable().pipe(
      finalize(() => {
        entry.subscribers--;
        if (entry.subscribers <= 0) {
          // cleanup simples: remove stream sem assinantes
          this.streams.delete(orderId);
        }
      }),
    );

    return merge(live$, ping$);
  }

  /**
   * Publica um evento ao vivo (in-memory).
   * Use isso após persistir OrderEvent no banco (idealmente após commit).
   */
  publish(ev: OrderEventMessage) {
    const entry = this.getOrCreate(ev.orderId);
    entry.subject.next(ev);
  }

  /**
   * Replay do banco (eventos recentes).
   * - se lastEventId vier, tentamos achar createdAt dele para “continuar”.
   * - se since (ISO) vier, usamos createdAt > since
   *
   * Nota: como id é UUID, o cursor perfeito exigiria um "sequence" numérico.
   * Aqui, o client pode deduplicar por id caso receba algo repetido.
   */
  async replay(args: {
    orderId: string;
    limit?: number;
    sinceIso?: string;
    lastEventId?: string;
  }): Promise<OrderEventMessage[]> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);

    let sinceDate: Date | null = null;

    if (args.lastEventId) {
      const last = await this.prisma.orderEvent.findUnique({
        where: { id: args.lastEventId },
        select: { createdAt: true, orderId: true },
      });

      // evita usar lastEventId de outro pedido
      if (last && last.orderId === args.orderId) sinceDate = last.createdAt;
    }

    if (!sinceDate && args.sinceIso) {
      const d = new Date(args.sinceIso);
      if (!Number.isNaN(d.getTime())) sinceDate = d;
    }

    const rows = await this.prisma.orderEvent.findMany({
      where: {
        orderId: args.orderId,
        ...(sinceDate ? { createdAt: { gt: sinceDate } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        orderId: true,
        type: true,
        payload: true,
        createdAt: true,
      },
    });

    return rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      type: r.type,
      payload: (r.payload ?? null) as Prisma.JsonValue | null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
