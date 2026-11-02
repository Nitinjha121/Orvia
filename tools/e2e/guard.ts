import { isTestDatabaseName } from '../../packages/shared/src/test-target.js';

/**
 * Refuses a database that is not clearly a test database to prevent
 * test suites from writing test sessions or recordings into production databases.
 */
export function assertTestDatabase(url: string): string {
  const name = url.split('/').pop()?.split('?')[0] ?? '';

  if (!isTestDatabaseName(name)) {
    throw new Error(
      `Refusing to run a test suite against database "${name}".\n` +
        `These suites write real sessions, transcripts and RECORDINGS into the\n` +
        `database they are pointed at.\n\n` +
        `Point them at a test database whose name contains "test", e.g.\n` +
        `  DATABASE_URL=postgresql://postgres@localhost:5432/orvia_test\n\n` +
        `Create it once with:  createdb orvia_test && DATABASE_URL=... pnpm db:push && pnpm --filter @orvia/api seed`,
    );
  }
  return url;
}

/**
 * Refuses to run against an API that is not pointed at a test database and test data directory,
 * ensuring test suites do not write test artifacts into the development environment.
 */
export async function assertTestApi(apiUrl: string): Promise<void> {
  let health: {
    ok?: boolean;
    target?: { database?: string; dataDir?: string; test?: boolean };
  };
  try {
    health = (await fetch(`${apiUrl}/api/health`).then((r) => r.json())) as typeof health;
  } catch {
    throw new Error(
      `Cannot reach the API at ${apiUrl}.\n` +
        `Start one against the TEST database first:  pnpm api:test`,
    );
  }

  const t = health?.target;
  if (!t) {
    throw new Error(
      `The API at ${apiUrl} does not report which database it is using, so it\n` +
        `cannot be verified as a test target. It is running an older build —\n` +
        `rebuild it (pnpm build) and start it with:  pnpm api:test`,
    );
  }
  if (t.test !== true) {
    throw new Error(
      `Refusing to run a test suite against the API at ${apiUrl}.\n\n` +
        `  database: ${t.database ?? '(unknown)'}\n` +
        `  data dir: ${t.dataDir ?? '(unknown)'}\n\n` +
        `That API writes sessions and RECORDINGS to a real target. Recordings are\n` +
        `the one artefact here that cannot be regenerated.\n\n` +
        `Most likely a "pnpm dev" server is already on that port. Stop it, then:\n` +
        `  pnpm api:test\n\n` +
        `Or point the suite elsewhere with E2E_API=http://localhost:<port>`,
    );
  }
}
