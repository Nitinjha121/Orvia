/**
 * Cloudflare R2 object storage client with upload budgeting.
 * Archiving is disabled unless all R2 environment variables are defined.
 * Storage ceilings are enforced before every upload.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV, type Env } from '../config/env';
import { sign, type R2Credentials } from './sigv4';

/** R2 Standard free allowance. */
export const FREE_TIER_BYTES = 10 * 1024 ** 3;
/** Refuse to upload past this. Headroom for a month's writes and a bad day. */
export const CEILING = 0.75;
/** Surface it from here, so there is time to choose what to drop. */
export const WARN_AT = 0.5;

const R2_VARS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

/**
 * `fetch` has no default timeout, and an evaluation that awaits a hung PUT
 * holds its session in `EvaluationService.running` until the process restarts,
 * which also blocks every re-run of that round.
 */
const SMALL_REQUEST_MS = 30_000;
/** Floor for a body transfer, plus a second per 100KB on top. */
const TRANSFER_BASE_MS = 60_000;
const TRANSFER_BYTES_PER_MS = 100;
const GET_TIMEOUT_MS = 10 * 60_000;
const ATTEMPTS = 3;

export type StoredObject = { body: Buffer; meta: Record<string, string> };

/**
 * Proves the endpoint is R2 on the configured account. An S3-compatible URL
 * pasted from the wrong console would otherwise sign happily against it.
 */
function assertR2Endpoint(endpoint: string, accountId: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`R2_ENDPOINT is not a URL: ${endpoint}`);
  }
  const host = url.host.toLowerCase();
  const ok =
    url.protocol === 'https:' &&
    (url.pathname === '/' || url.pathname === '') &&
    new RegExp(`^${accountId.toLowerCase().replace(/[^a-z0-9]/g, '\\$&')}\\.(eu\\.|fedramp\\.)?r2\\.cloudflarestorage\\.com$`).test(host);
  if (!ok) {
    throw new Error(
      `R2_ENDPOINT must be https://${accountId}.r2.cloudflarestorage.com (no path) — got ${endpoint}. ` +
        'Refusing to start rather than sign requests to an endpoint that is not this R2 account.',
    );
  }
}

/** Exported for `verify:archive`, which checks the refusal without booting Nest. */
export function readR2Config(env: Partial<Env>): R2Credentials | null {
  const values = R2_VARS.map((k) => [k, (env[k] as string | undefined)?.trim() || ''] as const);
  const set = values.filter(([, v]) => v);
  if (!set.length) return null;
  if (set.length !== values.length) {
    const missing = values.filter(([, v]) => !v).map(([k]) => k);
    throw new Error(
      `R2 is half-configured: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} empty. ` +
        'Set all five R2_* variables to archive rounds, or none to keep every recording on local disk.',
    );
  }
  const v = Object.fromEntries(values) as Record<(typeof R2_VARS)[number], string>;
  assertR2Endpoint(v.R2_ENDPOINT, v.R2_ACCOUNT_ID);
  return {
    accountId: v.R2_ACCOUNT_ID,
    bucket: v.R2_BUCKET,
    endpoint: v.R2_ENDPOINT,
    accessKeyId: v.R2_ACCESS_KEY_ID,
    secretAccessKey: v.R2_SECRET_ACCESS_KEY,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly creds: R2Credentials | null;
  /**
   * Bytes believed to be in the bucket, INCLUDING uploads in flight. Seeded at
   * boot from `sessions.archive_bytes` rather than by listing the bucket, which
   * this signer cannot do. It only counts THIS database's rounds: a second
   * stack on the same bucket is invisible to it, which is why `pnpm
   * audio:status` reports the bucket's own figure beside it.
   */
  private used = 0;

  constructor(@Inject(ENV) env: Env) {
    this.creds = readR2Config(env);
    if (this.creds) {
      this.log.log(`R2 archiving enabled — bucket ${this.creds.bucket}`);
    } else {
      this.log.log('R2 not configured — recordings stay on local disk (archiving off)');
    }
  }

  isEnabled(): boolean {
    return this.creds !== null;
  }

  setUsedBytes(bytes: number) {
    this.used = bytes;
  }

  usage() {
    const fraction = this.used / FREE_TIER_BYTES;
    return {
      usedBytes: this.used,
      freeTierBytes: FREE_TIER_BYTES,
      fraction,
      warn: fraction >= WARN_AT,
      full: fraction >= CEILING,
    };
  }

  /** True when `extra` more bytes would still sit under the ceiling. */
  hasRoomFor(extra: number): boolean {
    return (this.used + extra) / FREE_TIER_BYTES < CEILING;
  }

  private require(): R2Credentials {
    if (!this.creds) throw new Error('R2 is not configured');
    return this.creds;
  }

  /**
   * One signed request, bounded and retried. Every verb here is idempotent —
   * a PUT re-sends the same bytes to the same key — so a retry cannot leave
   * anything a first attempt would not have. Re-signed per attempt because the
   * signature carries a timestamp.
   */
  private async send(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    key: string,
    timeoutMs: number,
    body?: Buffer,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const creds = this.require();
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const { url, headers } = sign(creds, method, key, body, extra);
        const signal = AbortSignal.timeout(timeoutMs);
        const res = await fetch(url, { method, headers, body, signal });
        const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
        if (res.status >= 500 || res.status === 429) {
          lastError = new Error(`R2 ${method} ${key}: ${res.status} ${buf.toString('utf8', 0, 200)}`);
        } else {
          return { status: res.status, headers: res.headers, body: buf };
        }
      } catch (e) {
        lastError = e;
      }
      if (attempt < ATTEMPTS) await sleep(1000 * 3 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * `meta` becomes `x-amz-meta-<name>` and comes back on every GET, which is
   * how a restore proves it rebuilt the file that was archived.
   */
  async put(key: string, body: Buffer, contentType: string, meta: Record<string, string> = {}): Promise<void> {
    this.require();
    if (!this.hasRoomFor(body.length)) {
      const u = this.usage();
      throw new Error(
        `R2 budget: ${(u.fraction * 100).toFixed(1)}% of the free tier used; ` +
          `uploading ${(body.length / 1024 ** 2).toFixed(1)}MB would cross the ` +
          `${CEILING * 100}% ceiling. Delete some rounds first.`,
      );
    }
    // Reserved BEFORE the request so two concurrent uploads cannot both pass
    // the check above against the same figure.
    this.used += body.length;
    try {
      const headers: Record<string, string> = {
        'content-type': contentType,
        'content-length': String(body.length),
      };
      for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
      const res = await this.send(
        'PUT', key, TRANSFER_BASE_MS + Math.ceil(body.length / TRANSFER_BYTES_PER_MS), body, headers,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`R2 PUT ${key} failed: ${res.status} ${res.body.toString('utf8', 0, 300)}`);
      }
    } catch (e) {
      this.used = Math.max(0, this.used - body.length);
      throw e;
    }
  }

  /** The object and its `x-amz-meta-*` headers, or null when it is absent. */
  async getObject(key: string): Promise<StoredObject | null> {
    const res = await this.send('GET', key, GET_TIMEOUT_MS);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`R2 GET ${key} failed: ${res.status}`);
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) !== res.body.length) {
      throw new Error(`R2 GET ${key}: received ${res.body.length} of ${declared} bytes`);
    }
    const meta: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.toLowerCase().startsWith('x-amz-meta-')) meta[k.toLowerCase().slice(11)] = v;
    });
    return { body: res.body, meta };
  }

  async get(key: string): Promise<Buffer> {
    const obj = await this.getObject(key);
    if (!obj) throw new Error(`R2 GET ${key} failed: 404`);
    return obj.body;
  }

  /** Size in bytes, or null when the object is absent. */
  async head(key: string): Promise<number | null> {
    const res = await this.send('HEAD', key, SMALL_REQUEST_MS);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`R2 HEAD ${key} failed: ${res.status}`);
    const len = res.headers.get('content-length');
    if (len === null) throw new Error(`R2 HEAD ${key}: no content-length`);
    return Number(len);
  }

  async delete(key: string, knownSize = 0): Promise<void> {
    const res = await this.send('DELETE', key, SMALL_REQUEST_MS);
    // 404 is the state the caller asked for.
    if ((res.status < 200 || res.status >= 300) && res.status !== 404) {
      throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
    }
    this.used = Math.max(0, this.used - knownSize);
  }
}
