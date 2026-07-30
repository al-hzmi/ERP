import { describe, expect, it } from 'vitest';
import {
  InMemoryRateLimitStore,
  RATE_LIMIT_RULES,
  rateLimitHeaders,
  type RateLimitRule,
} from '@/lib/infrastructure/security/rate-limit';

/**
 * The per-instance store and the header contract.
 *
 * The shared store's arithmetic lives in SQL and is tested against a real
 * database in `tests/integration/rate-limit-shared.test.ts` — a fake would only
 * prove that the fake agrees with itself, and the property that matters
 * (atomicity between a check and an increment) exists nowhere but in Postgres.
 *
 * What is worth asserting here is the behaviour both stores promise: a window
 * that slides, a refusal that says when to come back, and a counter that does not
 * grow without bound.
 */

const rule: RateLimitRule = { limit: 3, windowSeconds: 60 };

describe('InMemoryRateLimitStore', () => {
  it('admits exactly the limit and then refuses', async () => {
    const store = new InMemoryRateLimitStore();

    const first = await store.hit('k', rule);
    const second = await store.hit('k', rule);
    const third = await store.hit('k', rule);
    const fourth = await store.hit('k', rule);

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, true]);
    expect(fourth.allowed).toBe(false);
  });

  it('counts down the remaining allowance', async () => {
    const store = new InMemoryRateLimitStore();

    expect((await store.hit('k', rule)).remaining).toBe(2);
    expect((await store.hit('k', rule)).remaining).toBe(1);
    expect((await store.hit('k', rule)).remaining).toBe(0);
  });

  it('tells a refused caller when to retry, and never says zero', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < rule.limit; i += 1) await store.hit('k', rule);

    const refused = await store.hit('k', rule);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);
  });

  it('keeps keys independent, so one caller cannot spend another\'s allowance', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < rule.limit; i += 1) await store.hit('a', rule);

    expect((await store.hit('a', rule)).allowed).toBe(false);
    expect((await store.hit('b', rule)).allowed).toBe(true);
  });

  it('forgets a key on reset, so one bad password is not remembered', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < rule.limit; i += 1) await store.hit('k', rule);
    expect((await store.hit('k', rule)).allowed).toBe(false);

    await store.reset('k');

    expect((await store.hit('k', rule)).allowed).toBe(true);
  });

  it('admits again once the window has passed', async () => {
    const store = new InMemoryRateLimitStore();
    const fast: RateLimitRule = { limit: 2, windowSeconds: 1 };

    await store.hit('k', fast);
    await store.hit('k', fast);
    expect((await store.hit('k', fast)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect((await store.hit('k', fast)).allowed).toBe(true);
  });

  it('discards idle keys, because one row per client IP grows forever', async () => {
    const store = new InMemoryRateLimitStore();
    await store.hit('idle', rule);
    expect(store.trackedKeys).toBe(1);

    // A horizon of zero makes every recorded hit older than the cutoff.
    const removed = await store.sweep(0);

    expect(removed).toBe(1);
    expect(store.trackedKeys).toBe(0);
  });

  it('keeps active keys through a sweep', async () => {
    const store = new InMemoryRateLimitStore();
    await store.hit('active', rule);

    await store.sweep(3600);

    expect(store.trackedKeys).toBe(1);
  });
});

describe('rate limit rules', () => {
  it('holds authentication an order of magnitude tighter than the general API', () => {
    // Guessing repeatedly is the attack on the auth endpoint and on no other, so
    // if these ever converge it is a regression rather than a tuning choice.
    expect(RATE_LIMIT_RULES.auth.limit * 5).toBeLessThan(RATE_LIMIT_RULES.api.limit);
  });
});

describe('rateLimitHeaders', () => {
  it('advertises the allowance so a client can back off before being refused', () => {
    const headers = rateLimitHeaders({
      allowed: true,
      limit: 100,
      remaining: 42,
      retryAfterSeconds: 0,
      resetAt: new Date(1_800_000_000_000),
    });

    expect(headers['X-RateLimit-Limit']).toBe('100');
    expect(headers['X-RateLimit-Remaining']).toBe('42');
    expect(headers['X-RateLimit-Reset']).toBe('1800000000');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('adds Retry-After only when the request was refused', () => {
    const headers = rateLimitHeaders({
      allowed: false,
      limit: 100,
      remaining: 0,
      retryAfterSeconds: 30,
      resetAt: new Date(1_800_000_000_000),
    });

    expect(headers['Retry-After']).toBe('30');
  });
});
