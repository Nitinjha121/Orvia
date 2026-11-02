import { expire } from '../common/expire';
import type { ModelAvailabilityService } from '../gemini/model-availability.service';

/**
 * Executes a prioritized model fallback chain, shared across evaluator,
 * code checking, and information extraction.
 */

export type ChainAvailability = Pick<
  ModelAvailabilityService,
  'order' | 'noteQuotaError' | 'noteError' | 'noteSuccess'
>;

/**
 * Classification of fallback failure kinds:
 * - `quota` / `timeout` / `error`: triggers model cooldown and fallback.
 * - `unavailable` (503): immediate retry with backoff before fallback.
 * - `invalid_request` / `bad_output`: payload or formatting error; avoids cooldown.
 */
export type FailureKind = 'quota' | 'unavailable' | 'invalid_request' | 'bad_output' | 'timeout' | 'error';

export type ChainFailure = { model: string; kind: FailureKind; message: string };

export type ChainResult<T> =
  | { ok: true; value: T; model: string; failures: ChainFailure[] }
  | { ok: false; failures: ChainFailure[] };

export type WalkOptions = {
  /** Attempts per model on a 503. */
  unavailableAttempts?: number;
  /** Grows per attempt. */
  backoffMs?: number;
  /** Deadline per call; the call's `signal` is aborted when it fires. */
  callTimeoutMs?: number;
  /** Deadline for the whole walk. */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const TIMED_OUT = Symbol('timed out');

export function classifyFailure(e: unknown): FailureKind {
  const err = e as { name?: string; message?: string; status?: number } | null;
  if (err?.name === 'ZodError' || e instanceof SyntaxError) return 'bad_output';
  const msg = err?.message ?? '';
  const status = typeof err?.status === 'number' ? err.status : null;
  if (status === 429 || /\b429\b/.test(msg) || msg.includes('RESOURCE_EXHAUSTED')) return 'quota';
  if (status === 503 || /\b503\b/.test(msg) || msg.includes('UNAVAILABLE')) return 'unavailable';
  if (status === 400 || status === 413 || msg.includes('INVALID_ARGUMENT')) return 'invalid_request';
  return 'error';
}

export async function walkChain<T>(
  chain: readonly string[],
  availability: ChainAvailability,
  call: (model: string, signal: AbortSignal) => Promise<T>,
  opts: WalkOptions = {},
): Promise<ChainResult<T>> {
  const attempts = Math.max(1, opts.unavailableAttempts ?? 3);
  const backoffMs = opts.backoffMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  const failures: ChainFailure[] = [];

  const remaining = () => (opts.budgetMs === undefined ? Infinity : opts.budgetMs - (now() - started));

  for (const model of availability.order(chain)) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (remaining() <= 0) {
        failures.push({ model, kind: 'timeout', message: `walk budget of ${opts.budgetMs}ms spent` });
        return { ok: false, failures };
      }

      const controller = new AbortController();
      const limit = Math.min(opts.callTimeoutMs ?? Infinity, remaining());
      try {
        const running = call(model, controller.signal);
        let value: T;
        if (Number.isFinite(limit)) {
          running.catch(() => {});
          const deadline = expire(limit, TIMED_OUT);
          const got = await Promise.race([running, deadline.promise]);
          deadline.cancel();
          if (got === TIMED_OUT) {
            controller.abort();
            throw Object.assign(new Error(`no reply within ${Math.round(limit)}ms`), { name: 'ChainTimeout' });
          }
          value = got as T;
        } else {
          value = await running;
        }
        availability.noteSuccess(model);
        return { ok: true, value, model, failures };
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        const kind: FailureKind = (e as Error)?.name === 'ChainTimeout' ? 'timeout' : classifyFailure(e);
        failures.push({ model, kind, message });

        if (kind === 'quota') {
          availability.noteQuotaError(model, message);
          break;
        }
        if (kind === 'unavailable' && attempt < attempts) {
          await sleep(backoffMs * attempt);
          continue;
        }
        if (kind === 'invalid_request' || kind === 'bad_output') break;
        availability.noteError(model);
        break;
      }
    }
  }
  return { ok: false, failures };
}

/** The last failure as an Error, for callers that throw. */
export function chainError(failures: ChainFailure[], what: string): Error {
  const last = failures[failures.length - 1];
  return new Error(last ? `${what}: ${last.model} ${last.kind} — ${last.message.slice(0, 300)}` : `${what}: no model to try`);
}
