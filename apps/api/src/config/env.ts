import { z } from 'zod';
import { isTestDatabaseName } from '@orvia/shared';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(8787),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  GEMINI_API_KEY: z.string().min(10, 'GEMINI_API_KEY is missing — copy .env.example to .env'),
  DATABASE_URL: z.string().default('postgresql://postgres@localhost:5432/orvia'),
  DATA_DIR: z.string().default('./data'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters — generate one with: openssl rand -base64 48'),

  /**
   * Cloudflare R2, for archiving finished rounds. Optional: without credentials,
   * recordings stay on local disk. Credentials must be passed explicitly to
   * avoid picking up ambient AWS_PROFILE configurations.
   */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * TEST STACKS ONLY. Stops forwarding the candidate's audio upstream this many
   * ms into a round to simulate a deaf connection for `test:deaf`. Ignored
   * unless `isTestTarget`, so no real round can ever be affected.
   */
  E2E_FAULT_DEAF_AFTER_MS: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = 'ENV';

/** Database name out of a connection URL, without credentials or host. */
export const databaseName = (url: string) => url.split('/').pop()?.split('?')[0] ?? '';

/** Last path segment, so no absolute path is ever reported. */
export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** True when BOTH the database and the data directory are clearly test targets. */
export const isTestTarget = (env: Pick<Env, 'DATABASE_URL' | 'DATA_DIR'>) =>
  isTestDatabaseName(databaseName(env.DATABASE_URL)) && isTestDatabaseName(basename(env.DATA_DIR));
