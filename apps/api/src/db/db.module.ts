import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { createDb, type Database } from '@orvia/db';
import { ENV, type Env } from '../config/env';
import { assertSchemaCurrent } from './schema-check';

export const DB = 'DB';
const DB_CLIENT = 'DB_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) => createDb(env.DATABASE_URL),
    },
    {
      provide: DB,
      inject: [DB_CLIENT, ENV],
      // Checked HERE, before anything can inject the database: the boot sweeps
      // in `SessionService` and `EvaluationService` query it in their own
      // `onModuleInit` and would otherwise fail first, with the vaguer error.
      useFactory: async (c: ReturnType<typeof createDb>, env: Env) => {
        await assertSchemaCurrent(c.db, env.DATABASE_URL.split('/').pop()?.split('?')[0] ?? 'database');
        return c.db;
      },
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CLIENT) private readonly conn: ReturnType<typeof createDb>) {}

  async onApplicationShutdown() {
    await this.conn.client.end({ timeout: 5 });
  }
}

export type { Database };
