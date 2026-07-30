import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma';
import { logger } from '../logging/logger';

/**
 * Request rate limiting.
 *
 * The window is sliding rather than fixed because a fixed window lets a caller
 * send 2x the limit across a boundary in a fraction of a second.
 *
 * Where the count lives is a deployment decision, not a policy one, so it sits
 * behind `RateLimitStore`. Two implementations ship:
 *
 *   - `InMemoryRateLimitStore` keeps timestamps in a process-local map. Exact,
 *     free, and only protects the instance it runs in — behind N instances the
 *     effective limit is N times the configured one.
 *   - `PostgresRateLimitStore` keeps two counters per key in a shared table, so
 *     every instance decrements the same allowance. Costs one round trip per
 *     request and approximates the previous window's contribution rather than
 *     recording every arrival.
 *
 * Production defaults to the shared store, because a limit that multiplies by the
 * instance count is not the limit anyone configured. Everything else defaults to
 * memory, so a test suite and a dev server need no database to be rate limited.
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

/** The longest window in play, which is how long a counter stays relevant. */
const LONGEST_WINDOW_SECONDS = Math.max(
  ...Object.values(RATE_LIMIT_RULES).map((rule) => rule.windowSeconds),
);

/**
 * One method, plus the two operations that are not "record a hit": clearing a key
 * and discarding counters nobody will consult again.
 */
export interface RateLimitStore {
  readonly name: string;
  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
  /** Returns how many counters were discarded. */
  sweep(olderThanSeconds: number): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryRateLimitStore implements RateLimitStore {
  readonly name = 'memory';

  /** key -> ascending list of request timestamps (ms) within the window. */
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
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

  /** Clears a key after a successful login, so one bad password is not remembered. */
  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }

  async sweep(olderThanSeconds: number): Promise<number> {
    const horizon = Date.now() - olderThanSeconds * 1000;
    let removed = 0;

    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((time) => time > horizon);
      if (recent.length === 0) {
        this.hits.delete(key);
        removed += 1;
      } else {
        this.hits.set(key, recent);
      }
    }

    return removed;
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
    void this.sweep(15 * 60);
  }

  get trackedKeys(): number {
    return this.hits.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Postgres
// ─────────────────────────────────────────────────────────────────────────────

interface RateLimitHitRow {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retry_after_seconds: number;
  readonly reset_at: Date;
}

/**
 * The shared store.
 *
 * All three operations are single function calls: the read-decide-increment
 * sequence has to be atomic, and expressed as separate statements from here two
 * instances interleave between the check and the increment and both are admitted.
 * See migration 005 for the arithmetic.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  readonly name = 'postgres';

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const rows = await prisma.$queryRaw<RateLimitHitRow[]>`
      SELECT allowed, remaining, retry_after_seconds, reset_at
        FROM erp_rate_limit_hit(${key}, ${rule.limit}::int, ${rule.windowSeconds}::int)
    `;

    const row = rows[0];
    if (row === undefined) {
      // A set-returning function that returns no row is not a condition this
      // code can interpret, and guessing "allowed" would silently disable the
      // limiter. Let the caller's fallback decide.
      throw new Error('erp_rate_limit_hit returned no row');
    }

    return {
      allowed: row.allowed,
      limit: rule.limit,
      remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds,
      resetAt: row.reset_at,
    };
  }

  async reset(key: string): Promise<void> {
    // The function returns a row count rather than `void` precisely so this call
    // can be a query: the driver cannot deserialise `void`, and a reset that
    // throws leaves a signed-in user still counted against the auth bucket.
    await prisma.$queryRaw<{ erp_rate_limit_reset: number }[]>`
      SELECT erp_rate_limit_reset(${key})
    `;
  }

  async sweep(olderThanSeconds: number): Promise<number> {
    const rows = await prisma.$queryRaw<{ erp_rate_limit_sweep: number }[]>`
      SELECT erp_rate_limit_sweep(${olderThanSeconds}::int)
    `;
    return rows[0]?.erp_rate_limit_sweep ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

function selectStore(): RateLimitStore {
  const configured = process.env['RATE_LIMIT_STORE'];

  if (configured === 'memory') return new InMemoryRateLimitStore();
  if (configured === 'postgres') return new PostgresRateLimitStore();

  if (configured !== undefined && configured !== '') {
    logger.warn('Unrecognised RATE_LIMIT_STORE, falling back to the default', {
      configured,
    });
  }

  return process.env.NODE_ENV === 'production'
    ? new PostgresRateLimitStore()
    : new InMemoryRateLimitStore();
}

const globalForLimiter = globalThis as unknown as {
  rateLimitStore: RateLimitStore | undefined;
  rateLimitFallback: InMemoryRateLimitStore | undefined;
};

const store: RateLimitStore = globalForLimiter.rateLimitStore ?? selectStore();

/**
 * Where requests are counted when the shared store is unreachable.
 *
 * A rate limiter that fails closed converts a database blip into a total outage,
 * which is the attack it exists to prevent, self-inflicted. Failing fully open
 * removes the protection entirely. Degrading to a per-instance limit keeps a
 * ceiling in force — the one this system had before the shared store existed —
 * and says so in the log.
 */
const fallback: InMemoryRateLimitStore =
  globalForLimiter.rateLimitFallback ?? new InMemoryRateLimitStore();

if (process.env.NODE_ENV !== 'production') {
  globalForLimiter.rateLimitStore = store;
  globalForLimiter.rateLimitFallback = fallback;
}

/** Which store is active. For the health endpoint and for tests. */
export const rateLimitStoreName: string = store.name;

/**
 * Keys are bounded because the column is.
 *
 * An identifier can be a client-supplied header, so its length is not this
 * module's to assume. Hashing the whole key past the limit keeps distinct callers
 * distinct; truncating would merge them and let one caller spend another's
 * allowance.
 */
const MAX_KEY_LENGTH = 256;

function buildKey(scope: RateLimitScope, identifier: string): string {
  const key = `${scope}:${identifier}`;
  if (key.length <= MAX_KEY_LENGTH) return key;

  const digest = createHash('sha256').update(identifier).digest('hex');
  return `${scope}:sha256:${digest}`;
}

/**
 * Applies the rule for `scope` to `identifier`.
 *
 * The identifier should be the most specific stable thing available — a user id
 * for an authenticated call, an IP for an anonymous one. Keying auth attempts by
 * username *and* IP (rather than either alone) is what stops one attacker from
 * locking out every account from a single machine.
 */
export async function checkRateLimit(
  scope: RateLimitScope,
  identifier: string,
): Promise<RateLimitResult> {
  const key = buildKey(scope, identifier);
  const rule = RATE_LIMIT_RULES[scope];

  try {
    return await store.hit(key, rule);
  } catch (error) {
    logger.error('Rate limit store unavailable, degrading to a per-instance limit', {
      store: store.name,
      scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback.hit(key, rule);
  }
}

export async function resetRateLimit(scope: RateLimitScope, identifier: string): Promise<void> {
  const key = buildKey(scope, identifier);

  // Both stores, always. The fallback may hold hits recorded during an outage,
  // and leaving them behind would keep counting a user who has just proved who
  // they are.
  await Promise.allSettled([store.reset(key), fallback.reset(key)]);
}

/**
 * Discards counters that can no longer influence a decision.
 *
 * A counter stops mattering two windows after its last hit: one for the window it
 * is in, one for the previous-window term that decays out of the estimate. Called
 * by the scheduled worker — one row per distinct key means one row per distinct
 * client IP, which grows for as long as the deployment has visitors.
 */
export async function sweepRateLimits(): Promise<number> {
  const horizon = LONGEST_WINDOW_SECONDS * 2;
  const [shared, local] = await Promise.all([
    store.sweep(horizon).catch((error: unknown) => {
      logger.error('Rate limit sweep failed', {
        store: store.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }),
    fallback.sweep(horizon),
  ]);

  return shared + local;
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
