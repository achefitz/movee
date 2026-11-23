/**
 * Fixed-window attempt limiter (in memory; fine for a single API instance).
 * Used to slow down password guessing per IP and per username.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private max: number, private windowMs: number) {}

  /** Seconds until the key may try again, or 0 if allowed now. */
  retryAfter(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) return 0;
    return h.count >= this.max ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }

  hit(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
    if (this.hits.size > 50000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
  }

  reset(key: string) {
    this.hits.delete(key);
  }
}
