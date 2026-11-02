import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * The API package root, derived from the compiled file's own location rather
 * than `process.cwd()`. Without this, running the server from the monorepo root
 * silently loads no `.env` and writes recordings to the wrong directory — both
 * failures that look like something else entirely.
 */
export const APP_ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
})();

export const ENV_FILE = resolve(APP_ROOT, '.env');
