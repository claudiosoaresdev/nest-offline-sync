import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().optional().default(3333),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  ADMIN_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
