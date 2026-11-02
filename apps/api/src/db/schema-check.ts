import { is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '@orvia/db';
import type { Database } from '@orvia/db';

/**
 * Every column the code's schema declares, as `table.column`.
 *
 * Read from the drizzle tables themselves, so a new column is covered the day
 * it is added and there is no second list to forget.
 */
export function expectedColumns(tables: Record<string, unknown> = schema): string[] {
  return Object.values(tables)
    .filter((t): t is PgTable => is(t, PgTable))
    .flatMap((t) => {
      const cfg = getTableConfig(t);
      return cfg.columns.map((c) => `${cfg.name}.${c.name}`);
    })
    .sort();
}

/** What the code declares and the database does not have. Extra columns are not drift. */
export function schemaDrift(expected: readonly string[], actual: readonly string[]): string[] {
  const have = new Set(actual);
  return expected.filter((c) => !have.has(c));
}

/**
 * Refuses to serve against a database whose schema is behind the code.
 * Fails fast at boot with the exact missing columns and migration command,
 * rather than failing runtime queries with 500s.
 */
export async function assertSchemaCurrent(db: Database, database: string): Promise<void> {
  const rows = (await db.execute(
    sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  )) as unknown as { table_name: string; column_name: string }[];
  const missing = schemaDrift(expectedColumns(), rows.map((r) => `${r.table_name}.${r.column_name}`));
  if (!missing.length) return;
  throw new Error(
    `The "${database}" database is behind the code — ${missing.length} column(s) missing: ` +
      `${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}.\n` +
      `Bring it up to date before starting the API:\n` +
      `  DATABASE_URL=<its url> pnpm db:push      (back up first: pnpm db:backup)`,
  );
}
