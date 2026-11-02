import { Injectable, Logger } from '@nestjs/common';

type Cooldown = {
  until: number;
  reason: 'daily' | 'minute' | 'error' | 'deaf';
  quotaId: string;
};

/**
 * Tracks model availability and cooldowns across quota limits, rate limits, and outages.
 *
 * Remembers which models are temporarily exhausted so fallback chains can route
 * requests directly to working models without repeatedly hitting 429 errors.
 * Maintained in-memory and reset on server restart.
 */
const DEAF_COOLDOWN_MS = 60 * 60_000;

@Injectable()
export class ModelAvailabilityService {
  private readonly log = new Logger(ModelAvailabilityService.name);
  private readonly cooldowns = new Map<string, Cooldown>();

  /** Orders a chain so usable models come first, preserving preference within each group. */
  order(chain: readonly string[]): string[] {
    const now = Date.now();
    const usable = chain.filter((m) => (this.cooldowns.get(m)?.until ?? 0) <= now);
    // Exhausted models are kept as a last resort rather than dropped: a cooldown
    // is an estimate, and trying a stale one beats failing with nothing left.
    const cooling = chain.filter((m) => (this.cooldowns.get(m)?.until ?? 0) > now);
    return [...usable, ...cooling];
  }

  isAvailable(model: string): boolean {
    return (this.cooldowns.get(model)?.until ?? 0) <= Date.now();
  }

  /** True only for a DAILY cap still in force — the one cooldown waiting cannot clear. */
  exhaustedForDay(model: string): boolean {
    const c = this.cooldowns.get(model);
    return !!c && c.reason === 'daily' && c.until > Date.now();
  }

  /**
   * Records a quota rejection. The error states which quota was hit, so the
   * cooldown matches reality instead of guessing: a per-minute limit clears in
   * seconds, a per-day limit not until Google's reset.
   */
  noteQuotaError(model: string, message: string) {
    const quotaId = message.match(/"quotaId":\s*"([^"]+)"/)?.[1] ?? '';
    const retryAfter = Number(message.match(/"retryDelay":\s*"(\d+)s"/)?.[1] ?? 0);

    if (/PerDay/i.test(quotaId)) {
      const until = nextDailyReset();
      this.cooldowns.set(model, { until, reason: 'daily', quotaId });
      this.log.warn(
        `${model} is out of daily quota (${quotaId}); skipping it until ` +
          `${new Date(until).toISOString()}`,
      );
      return;
    }

    const seconds = retryAfter > 0 ? retryAfter + 2 : 60;
    this.cooldowns.set(model, {
      until: Date.now() + seconds * 1000,
      reason: 'minute',
      quotaId: quotaId || 'per-minute',
    });
    this.log.warn(`${model} hit a rate limit; skipping it for ${seconds}s`);
  }

  /** A non-quota failure. Short cooldown so one bad response does not pin the chain. */
  noteError(model: string) {
    this.cooldowns.set(model, { until: Date.now() + 30_000, reason: 'error', quotaId: '' });
  }

  /**
   * Records a live model that connects and answers text but stops processing audio.
   * Placed on cooldown so new sessions route to a functioning fallback model.
   */
  noteDeaf(model: string) {
    this.cooldowns.set(model, { until: Date.now() + DEAF_COOLDOWN_MS, reason: 'deaf', quotaId: '' });
    this.log.warn(`${model} stopped hearing audio; skipping it for ${DEAF_COOLDOWN_MS / 60_000} minutes`);
  }

  noteSuccess(model: string) {
    // Connecting proves nothing about a deaf model: it connects fine.
    if (this.cooldowns.get(model)?.reason === 'deaf') return;
    this.cooldowns.delete(model);
  }

  /** Surfaced on /api/health so quota exhaustion is visible rather than mysterious. */
  status(): { model: string; availableAt: string; reason: string }[] {
    const now = Date.now();
    return [...this.cooldowns.entries()]
      .filter(([, c]) => c.until > now)
      .map(([model, c]) => ({
        model,
        availableAt: new Date(c.until).toISOString(),
        reason:
          c.reason === 'daily' ? 'daily quota exhausted'
          : c.reason === 'minute' ? 'rate limited'
          : c.reason === 'deaf' ? 'not hearing audio'
          : 'recent error',
      }));
  }
}

/**
 * Google's free-tier daily quotas roll over at midnight Pacific. Computed from
 * the actual Pacific date rather than assuming a fixed UTC offset, so this stays
 * correct across daylight saving.
 */
function nextDailyReset(): number {
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const pacificMidnight = new Date(pacificNow);
  pacificMidnight.setHours(24, 0, 0, 0);
  const msUntil = pacificMidnight.getTime() - pacificNow.getTime();
  return now.getTime() + msUntil;
}
