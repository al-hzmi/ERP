/**
 * Request rate limiting.
 *
 * A sliding-window counter held in process memory. That is the honest scope of
 * this implementation: it protects a single instance, and behind N instances the
 * effective limit is N times the configured one. For a deployment that needs a
 * global limit, `RateLimiter` is an interface with one method — swapping the map
 * for a Redis sorted set is a contained change, and the call sites do not move.
 *
 * The window is sliding rather than fixed because a fixed window lets an
 * attacker send 2x the limit across a boundary in a fraction of a second.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the caller may retry. Zero when allowed. */
  readonly retryAfterSeconds: number;
  readonly resetAt: Date;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * The rules. Authentication is an order of magnitude tighter than the general
 * API because it is the only endpoint where guessing repeatedly is the attack.
 */
export const RATE_LIMIT_RULES = {
  auth: { limit: 10, windowSeconds: 60 },
  api: { limit: 100, windowSeconds: 60 },
  search: { limit: 300, windowSeconds: 60 },
  export: { limit: 10, windowSeconds: 300 },
  mutation: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitScope = keyof typeof RATE_LIMIT_RULES;

class SlidingWindowRateLimiter {
  /** key -> ascending list of request timestamps (ms) within the window. */
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  check(key: string, rule: RateLimitRule): RateLimitResult {
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;
    const cutoff = now - windowMs;

    this.sweepIfDue(now);

    const timestamps = (this.hits.get(key) ?? []).filter((time) => time > cutoff);

    if (timestamps.length >= rule.limit) {
      const oldest = timestamps[0] ?? now;
      const retryAfterMs = oldest + windowMs - now;
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        resetAt: new Date(oldest + windowMs),
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - timestamps.length,
      retryAfterSeconds: 0,
      resetAt: new Date(now + windowMs),
    };
  }

  /**
   * Drops keys with no recent activity.
   *
   * Without this the map grows once per distinct IP forever, which is a memory
   * leak that presents as an OOM three weeks after deployment.
   */
  private sweepIfDue(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    const horizon = now - 15 * 60_000;
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((time) => time > horizon);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  /** Clears a key after a successful login, so one bad password is not remembered. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  get trackedKeys(): number {
    return this.hits.size;
  }
}

const globalForLimiter = globalThis as unknown as {
  rateLimiter: SlidingWindowRateLimiter | undefined;
};

const limiter = globalForLimiter.rateLimiter ?? new SlidingWindowRateLimiter();

if (process.env.NODE_ENV !== 'production') {
  globalForLimiter.rateLimiter = limiter;
}

/**
 * Applies the rule for `scope` to `identifier`.
 *
 * The identifier should be the most specific stable thing available — a user id
 * for an authenticated call, an IP for an anonymous one. Keying auth attempts by
 * username *and* IP (rather than either alone) is what stops one attacker from
 * locking out every account from a single machine.
 */
export function checkRateLimit(scope: RateLimitScope, identifier: string): RateLimitResult {
  return limiter.check(`${scope}:${identifier}`, RATE_LIMIT_RULES[scope]);
}

export function resetRateLimit(scope: RateLimitScope, identifier: string): void {
  limiter.reset(`${scope}:${identifier}`);
}

/** Standard headers so a well-behaved client can back off before being refused. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
  };
  if (!result.allowed) {
    headers['Retry-After'] = String(result.retryAfterSeconds);
  }
  return headers;
}
