import { assertTestApi } from './guard';

/** Run assertTestApi before suite execution, exiting with status 2 on failure. */
export async function preflight(api: string): Promise<void> {
  try {
    await assertTestApi(api);
  } catch (e) {
    console.error(`\n\x1b[31m${(e as Error).message}\x1b[0m\n`);
    process.exit(2);
  }
}
