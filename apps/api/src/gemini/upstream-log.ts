import type { UpstreamEvent } from './context-budget';

/** An `UpstreamEvent` as persisted: round time instead of epoch, and nothing undefined. */
export type StoredUpstreamEvent = Omit<UpstreamEvent, 'at'> & { atMs: number };

export function storeUpstreamEvent(e: UpstreamEvent, startedAt: number): StoredUpstreamEvent {
  const { at, ...rest } = e;
  const out: Record<string, unknown> = { atMs: Math.max(0, at - startedAt) };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== '') out[k] = v;
  return out as StoredUpstreamEvent;
}
