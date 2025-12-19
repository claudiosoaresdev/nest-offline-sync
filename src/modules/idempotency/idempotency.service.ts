import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/infra/database/prisma.service';

import { stableStringify } from './stable-stringify';

export type IdempotencyRecord = {
  key: string;
  requestHash: string | null;
  responseStatus: number | null;

  // ✅ tipado como JSON do Prisma (compatível com coluna Json)
  responseBody: Prisma.JsonValue | null;

  expiresAt: Date | null;
};

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  getTtlDays(): number {
    const v = this.config.get<number>('idempotency.ttlDays');
    return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 7;
  }

  getExpiresAt(now = new Date()): Date {
    const ttlDays = this.getTtlDays();
    const expires = new Date(now);
    expires.setDate(expires.getDate() + ttlDays);
    return expires;
  }

  computeRequestHash(
    method: string,
    path: string,
    body: Prisma.JsonValue,
  ): string {
    const base = `${method.toUpperCase()}::${path}::${stableStringify(body)}`;
    return createHash('sha256').update(base).digest('hex');
  }

  async cleanupExpired(): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  async findValid(key: string): Promise<IdempotencyRecord | null> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { key },
      select: {
        key: true,
        requestHash: true,
        responseStatus: true,
        responseBody: true,
        expiresAt: true,
      },
    });

    if (!row) return null;

    if (row.expiresAt && row.expiresAt < new Date()) {
      await this.prisma.idempotencyKey
        .delete({ where: { key } })
        .catch(() => {});
      return null;
    }

    return {
      key: row.key,
      requestHash: row.requestHash ?? null,
      responseStatus: row.responseStatus ?? null,
      responseBody: (row.responseBody ?? null) as Prisma.JsonValue | null,
      expiresAt: row.expiresAt ?? null,
    };
  }

  async createPending(args: {
    key: string;
    requestHash?: string | null;
    method?: string;
    path?: string;
  }): Promise<void> {
    const expiresAt = this.getExpiresAt();

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: args.key,
          requestHash: args.requestHash ?? null,
          method: args.method ?? null,
          path: args.path ?? null,
          expiresAt,
          responseStatus: null,
          responseBody: undefined,
        },
      });
    } catch {
      // corrida (já existe)
    }
  }

  async saveResponse(args: {
    key: string;
    requestHash?: string | null;
    status: number;

    // ✅ JSON do Prisma (sem unknown)
    body: Prisma.JsonValue;

    method?: string;
    path?: string;
  }): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key: args.key },
      data: {
        requestHash: args.requestHash ?? null,
        responseStatus: args.status,
        responseBody: args.body as Prisma.InputJsonValue,
        method: args.method ?? undefined,
        path: args.path ?? undefined,
      },
    });
  }

  assertSameHashOrThrow(
    storedHash: string | null,
    incomingHash: string | null,
  ) {
    if (!storedHash || !incomingHash) return;
    if (storedHash !== incomingHash) {
      throw new ConflictException(
        'Idempotency-Key reused with different payload',
      );
    }
  }
}
