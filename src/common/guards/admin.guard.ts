import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from 'src/config/env.schema';

type ReqWithHeaders = Request & {
  headers: Record<string, string | string[] | undefined>;
};

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    // Usa ConfigService (já validado via Zod no seu setup)
    const env = this.config.get<string>('DATABASE_URL') ?? 'development';
    const adminToken = this.config.get<string>('ADMIN_TOKEN'); // sugiro colocar no configuration.ts

    // Em dev/test: libera para facilitar testes locais
    if (env !== 'production') return true;

    // Em produção: exige token configurado
    if (!adminToken) {
      throw new ForbiddenException('Admin endpoints are disabled');
    }

    const req = context.switchToHttp().getRequest<ReqWithHeaders>();
    const provided = req.headers['x-admin-token'];

    // Header pode vir como string[] em alguns casos
    const providedToken = Array.isArray(provided) ? provided[0] : provided;

    if (providedToken !== adminToken) {
      throw new ForbiddenException('Invalid admin token');
    }

    return true;
  }
}
