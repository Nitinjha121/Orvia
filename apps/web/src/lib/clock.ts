/** The last `session.clock` the server sent, stamped with when it arrived. */
export type ServerClock = { remainingMs: number; budgetMs: number; receivedAt: number };

/** The server sends a clock every ~2s; never run a local estimate further past one than this. */
export const CLOCK_EXTRAPOLATE_MAX_MS = 2_000;

/**
 * Calculates displayed countdown time from server `remainingMs` and local extrapolation.
 * Freezes extrapolation when server ticks stall, and only displays zero once confirmed
 * by the server.
 */
export function displayRemainingMs(
  clock: ServerClock | null,
  fallback: { totalMs: number; elapsedMs: number },
  now: number,
): number {
  if (clock) {
    if (clock.remainingMs <= 0) return 0;
    const since = Math.min(Math.max(0, now - clock.receivedAt), CLOCK_EXTRAPOLATE_MAX_MS);
    return Math.max(1_000, clock.remainingMs - since);
  }
  return Math.max(1_000, fallback.totalMs - fallback.elapsedMs);
}
