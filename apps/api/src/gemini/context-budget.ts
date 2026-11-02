/**
 * Context budgeting for live sessions.
 *
 * Streaming audio continuously accumulates prompt tokens over time, eventually
 * causing the server to refuse the session once context limits are reached.
 * Renewing the session with a fresh socket and replaying the conversation as text
 * keeps token usage low while preserving full conversation history.
 */

/** Every upstream happening worth keeping, persisted as `upstream_events`. */
export type UpstreamEvent = {
  /** Epoch ms. The gateway converts to round time when it persists. */
  at: number;
  kind:
    | 'opened'
    | 'handover_warning'
    | 'closed'
    | 'resumed'
    | 'renewed'
    | 'renew_failed'
    | 'failover'
    | 'backlog_replayed'
    | 'turn_reason';
  model: string;
  /** Context size the decision was taken on, from `usageMetadata`. */
  tokens?: number;
  /** Close code and reason for `closed`; the turn's last words for `turn_reason`. */
  code?: number;
  reason?: string;
  /** Why a renewal happened, what kind of close it was, or a turn's `turnCompleteReason`. */
  why?: string;
  /** Audio replayed to a new socket, for `backlog_replayed`. */
  replayedMs?: number;
};

/** What a socket closing means, which decides how it is replaced. */
export type CloseKind =
  /** The server recycling a healthy socket, announced by `goAway` or clean. */
  | 'handover'
  /** The server refusing the session: 1011, "internal error", quota. */
  | 'refused'
  /** Anything else — a network drop. */
  | 'dropped';

const REFUSAL_RE = /internal error|exhausted|quota|unavailable|overloaded|try again/i;

export function classifyClose(code: number | undefined, reason: string | undefined, handoverPending: boolean): CloseKind {
  if (code === 1011 || code === 1013 || REFUSAL_RE.test(reason ?? '')) return 'refused';
  if (handoverPending || code === 1000 || code === undefined) return 'handover';
  return 'dropped';
}

/**
 * Minimum context growth required before a renewal can trigger, measured from
 * the socket's starting floor (prompt, tools, and replayed turns). This prevents
 * immediate renewal loops when the base prompt is already near the budget.
 */
export const RENEW_MIN_GROWTH_TOKENS = 6_000;

/**
 * Whether the context has outgrown the budget. `handover` is the lower bar:
 * the socket is going away anyway, so renewing then costs nothing extra.
 * `floor` is what a fresh socket started at — see `RENEW_MIN_GROWTH_TOKENS`.
 */
export function renewalDue(
  tokens: number,
  budget: { renewAt: number; renewAtHandover: number },
  handover: boolean,
  floor = 0,
): boolean {
  return tokens >= Math.max(handover ? budget.renewAtHandover : budget.renewAt, floor + RENEW_MIN_GROWTH_TOKENS);
}

/**
 * Past `renewAt` by this much, a renewal goes even mid-turn-gap without the
 * quiet it would prefer: the mic backlog makes a swap lossless, and waiting
 * for a pause that a narrating candidate never leaves is how the session
 * reaches the zone the budget exists to avoid.
 */
export const RENEW_OVERDUE_TOKENS = 4_000;

/** How long both sides must have been quiet for a renewal to count as unobtrusive. */
export const RENEW_QUIET_MS = 1_500;

/** Window for tracking recent server refusals to distinguish transient errors from sustained outages. */
export const REFUSAL_WINDOW_MS = 120_000;

/** Refusals in the window after which the model is failed over. */
export const REFUSALS_BEFORE_FAILOVER = 3;

/**
 * Wait before the next socket after the n-th refusal in the window. Immediate
 * first — a single 1011 is often a one-off — then backing off, because a socket
 * opened into a refusal is refused again within seconds and each attempt spends
 * the same quota the run is about.
 */
export function refusalBackoffMs(n: number): number {
  if (n <= 1) return 0;
  return Math.min(1_000 * 2 ** (n - 2), 8_000);
}

/** Refusal times within the window, oldest first. */
export class RefusalTracker {
  private times: number[] = [];

  record(now: number): number {
    this.times = this.times.filter((t) => now - t < REFUSAL_WINDOW_MS);
    this.times.push(now);
    return this.times.length;
  }

  count(now: number): number {
    return this.times.filter((t) => now - t < REFUSAL_WINDOW_MS).length;
  }

  clear() {
    this.times = [];
  }
}
