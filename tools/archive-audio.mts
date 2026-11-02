/**
 * Recording storage status reporter.
 * Archiving is managed by the API (`ArchiveService`), which encodes recordings
 * to FLAC and uploads them to cloud storage. This tool reports local recording
 * state and queries bucket storage metrics via wrangler.
 *
 *   pnpm audio:status
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API_ROOT = resolve(import.meta.dirname, '../apps/api');
const AUDIO_DIR = join(API_ROOT, 'data/audio');
const CACHE_DIR = join(API_ROOT, 'data/audio-cache');

/** Mirrors `apps/api/src/storage/storage.service.ts`. */
const FREE_TIER_BYTES = 10 * 1024 ** 3;
const CEILING = 0.75;
const WARN_AT = 0.5;

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };

/**
 * Verifies that the active CLI session matches the configured cloud storage account
 * before issuing commands.
 */
async function assertExpectedAccount() {
  const expected = apiEnv('R2_ACCOUNT_EMAIL').toLowerCase();
  if (!expected) {
    throw new Error('Set R2_ACCOUNT_EMAIL in apps/api/.env to the Cloudflare login that owns the bucket.');
  }
  const { stdout } = await run('wrangler', ['whoami'], { env: wranglerEnv });
  if (!stdout.toLowerCase().includes(expected)) {
    throw new Error(
      `wrangler is not logged in as ${expected} (R2_ACCOUNT_EMAIL).\n` +
        'Run `wrangler login` with that account, then retry.',
    );
  }
}

/**
 * `r2 object` commands WRITE TO A LOCAL MINIFLARE SIMULATION and exit 0 without
 * `--remote`, so it is appended to every one of them here. `r2 bucket`
 * commands reject the flag.
 */
async function wrangler(args: string[]) {
  const full = args[0] === 'r2' && args[1] === 'object' ? [...args, '--remote'] : args;
  return run('wrangler', full, { env: wranglerEnv, maxBuffer: 8 * 1024 ** 2 });
}

const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`;
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** From the process environment, else `apps/api/.env`. */
function apiEnv(key: string): string {
  if (process.env[key]?.trim()) return process.env[key]!.trim();
  const file = join(API_ROOT, '.env');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

const r2Bucket = () => apiEnv('R2_BUCKET');

async function sizeOf(dir: string, match: (name: string) => boolean) {
  const names = await readdir(dir).catch(() => [] as string[]);
  let bytes = 0;
  let n = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) {
      bytes += s.size;
      n++;
    }
  }
  return { n, bytes };
}

/** Parses `wrangler r2 bucket info --json`, whose size field is a string like "1.2 GB". */
function parseBucketSize(json: string): number | null {
  const info = JSON.parse(json) as Record<string, unknown>;
  const raw = info.bucket_size ?? info.bucketSize ?? info.size;
  if (typeof raw === 'number') return raw;
  const m = typeof raw === 'string' ? raw.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\b/i) : null;
  if (!m) return null;
  const unit = m[2]!.toLowerCase().replace('i', '');
  const scale: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Number(m[1]) * (scale[unit] ?? NaN);
}

async function main() {
  const argv = process.argv.slice(2);
  const retired = ['--compress', '--replace', '--upload', '--older-than'];
  const used = argv.filter((a) => retired.some((r) => a.startsWith(r)));
  if (used.length) {
    console.error(
      `\n${used.join(' ')}: retired. The API archives rounds itself, as FLAC, after evaluation.\n` +
        'This tool only reports now — see the header of tools/archive-audio.mts for why.\n',
    );
    process.exitCode = 1;
    return;
  }

  const wav = await sizeOf(AUDIO_DIR, (n) => n.endsWith('.wav') && !n.endsWith('.mix.wav'));
  const mix = await sizeOf(AUDIO_DIR, (n) => n.endsWith('.mix.wav'));
  const opus = await sizeOf(AUDIO_DIR, (n) => n.endsWith('.opus'));
  const pcm = await sizeOf(AUDIO_DIR, (n) => n.endsWith('.pcm'));
  const cache = await sizeOf(CACHE_DIR, () => true);

  console.log(`\nLocal — ${AUDIO_DIR}`);
  console.log(`  recordings (.wav)     ${String(wav.n).padStart(4)}  ${gb(wav.bytes)}`);
  console.log(`  playback mixes        ${String(mix.n).padStart(4)}  ${mb(mix.bytes)}  (derived, rebuilt on demand)`);
  console.log(`  retired .opus copies  ${String(opus.n).padStart(4)}  ${mb(opus.bytes)}  (lossy, read by nothing)`);
  if (pcm.n) console.log(`  unwrapped .pcm        ${String(pcm.n).padStart(4)}  ${mb(pcm.bytes)}  (salvaged at next boot)`);
  console.log(`  restore cache         ${String(cache.n).padStart(4)}  ${mb(cache.bytes)}  (${CACHE_DIR})`);

  const bucket = r2Bucket();
  console.log('\nCloudflare R2');
  if (!bucket) {
    console.log('  not configured — archiving is off and every recording stays local.\n');
    return;
  }
  await assertExpectedAccount();
  try {
    const { stdout } = await wrangler(['r2', 'bucket', 'info', bucket, '--json']);
    const size = parseBucketSize(stdout);
    if (size === null) {
      console.log(`  bucket ${bucket}: size not reported\n${stdout}`);
    } else {
      const frac = size / FREE_TIER_BYTES;
      const flag = frac >= CEILING ? 'AT CEILING — uploads refused' : frac >= WARN_AT ? 'WARN' : 'ok';
      const count = (JSON.parse(stdout) as { object_count?: string | number }).object_count ?? '?';
      console.log(`  bucket ${bucket}: ${count} objects, ${gb(size)} of ${gb(FREE_TIER_BYTES)} — ${pct(frac)} ${flag}`);
      console.log('  Compare with the "R2 archive:" line the API logs at boot. A bucket larger');
      console.log('  than that is holding objects no session row accounts for.');
    }
  } catch (e) {
    console.log(`  could not read bucket info: ${(e as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
