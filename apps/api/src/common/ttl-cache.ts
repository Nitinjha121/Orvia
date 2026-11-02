/**
 * In-memory TTL cache with bounded size and FIFO eviction.
 * Used for derived, cheap-to-recompute data where local process caching suffices.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { expiresAt: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000,
  ) {}

  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V): V {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value });
    return value;
  }

  /** Drops one key, or everything when called with no argument. */
  invalidate(key?: K): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /**
   * Compute on miss, with concurrent callers sharing one computation.
   *
   * The in-flight map is the point: without it a burst of requests against a
   * cold cache each runs the query the cache exists to avoid, which is exactly
   * when the instance is least able to afford it. A failure is not cached.
   */
  fetch(key: K, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, pending);
    return pending;
  }

  private readonly inFlight = new Map<K, Promise<V>>();
}
