import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The shared rate limiter, against a real database.
 *
 * The reason these are not unit tests: the property the shared store exists to
 * provide is that a check and an increment cannot interleave between two
 * instances. That property is `FOR UPDATE` on one row inside a plpgsql function,
 * and it does not exist anywhere a fake could reproduce it. A test that stubbed
 * the database would assert that the stub agrees with itself.
 *
 * The sliding window is verified by observation rather than by reading the
 * arithmetic back: a fixed window would admit a full second burst the instant a
 * boundary passes, and that is the specific failure this replaces.
 */

const databaseUrl = process.env['DATABASE_URL'];

const prisma = new PrismaClient();

interface HitRow {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
  reset_at: Date;
}

/** One request against a key. Each call is its own statement, as it is in production. */
async function hit(key: string, limit: number, windowSeconds: number): Promise<HitRow> {
  const rows = await prisma.$queryRaw<HitRow[]>`
    SELECT allowed, remaining, retry_after_seconds, reset_at
      FROM erp_rate_limit_hit(${key}, ${limit}::int, ${windowSeconds}::int)
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('erp_rate_limit_hit returned no row');
  return row;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('shared rate limiting', () => {
  beforeEach(async () => {
    await prisma.$executeRaw`DELETE FROM "rate_limit_counters" WHERE "key" LIKE 'spec:%'`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "rate_limit_counters" WHERE "key" LIKE 'spec:%'`;
    await prisma.$disconnect();
  });

  it('admits exactly the limit, then refuses', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await hit('spec:basic', 3, 60));

    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false]);
  });

  it('counts down the remaining allowance', async () => {
    expect((await hit('spec:remaining', 3, 60)).remaining).toBe(2);
    expect((await hit('spec:remaining', 3, 60)).remaining).toBe(1);
    expect((await hit('spec:remaining', 3, 60)).remaining).toBe(0);
  });

  it('keeps keys independent', async () => {
    for (let i = 0; i < 3; i += 1) await hit('spec:a', 3, 60);

    expect((await hit('spec:a', 3, 60)).allowed).toBe(false);
    expect((await hit('spec:b', 3, 60)).allowed).toBe(true);
  });

  it('is atomic: concurrent callers cannot exceed the limit between them', async () => {
    // The whole reason the counter is in the database. Twenty callers racing on one
    // key with an allowance of five: a check-then-increment expressed as two
    // statements admits far more than five here.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => hit('spec:race', 5, 60)),
    );

    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(5);
    expect(attempts.filter((attempt) => !attempt.allowed)).toHaveLength(15);
  });

  it('does not admit a full burst the moment a window boundary passes', async () => {
    // A fixed window would allow `limit` again immediately here, which is how a
    // caller sends 2x the limit either side of a boundary. The previous window's
    // hits are still weighted in, so the answer is still no.
    await hit('spec:slide', 2, 2);
    await hit('spec:slide', 2, 2);
    expect((await hit('spec:slide', 2, 2)).allowed).toBe(false);

    await sleep(2_100);

    expect((await hit('spec:slide', 2, 2)).allowed).toBe(false);
  }, 15_000);

  it('admits again once the previous window has decayed', async () => {
    await hit('spec:decay', 2, 2);
    await hit('spec:decay', 2, 2);

    // Two full windows on, nothing from the first is still in view.
    await sleep(4_200);

    expect((await hit('spec:decay', 2, 2)).allowed).toBe(true);
  }, 15_000);

  it('advises a retry delay that is actually long enough', async () => {
    for (let i = 0; i < 2; i += 1) await hit('spec:retry', 2, 3);
    const refused = await hit('spec:retry', 2, 3);

    expect(refused.allowed).toBe(false);
    expect(refused.retry_after_seconds).toBeGreaterThan(0);

    // Waiting exactly as long as the refusal advised must be enough. If the
    // arithmetic under-estimates, a well-behaved client that honours Retry-After
    // is refused a second time — which is how a back-off turns into a loop.
    await sleep(refused.retry_after_seconds * 1000 + 250);

    expect((await hit('spec:retry', 2, 3)).allowed).toBe(true);
  }, 20_000);

  it('forgets a key on reset', async () => {
    for (let i = 0; i < 3; i += 1) await hit('spec:reset', 3, 60);
    expect((await hit('spec:reset', 3, 60)).allowed).toBe(false);

    await prisma.$queryRaw`SELECT erp_rate_limit_reset('spec:reset')`;

    expect((await hit('spec:reset', 3, 60)).allowed).toBe(true);
  });

  it('sweeps counters that can no longer influence a decision', async () => {
    await hit('spec:sweep', 3, 60);
    await prisma.$executeRaw`
      UPDATE "rate_limit_counters"
         SET "updatedAt" = now() - interval '2 hours'
       WHERE "key" = 'spec:sweep'
    `;

    const swept = await prisma.$queryRaw<{ erp_rate_limit_sweep: number }[]>`
      SELECT erp_rate_limit_sweep(600::int)
    `;

    expect(swept[0]?.erp_rate_limit_sweep ?? 0).toBeGreaterThanOrEqual(1);
    const remaining = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM "rate_limit_counters" WHERE "key" = 'spec:sweep'
    `;
    expect(Number(remaining[0]?.count ?? 0)).toBe(0);
  });

  it('leaves counters that are still live', async () => {
    await hit('spec:live', 3, 60);

    await prisma.$queryRaw`SELECT erp_rate_limit_sweep(600::int)`;

    const remaining = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM "rate_limit_counters" WHERE "key" = 'spec:live'
    `;
    expect(Number(remaining[0]?.count ?? 0)).toBe(1);
  });

  it('refuses a nonsensical rule rather than silently disabling itself', async () => {
    // A limit of zero reaching the database is a configuration bug. Returning
    // "allowed" would turn it into an unlimited endpoint that looks rate limited.
    await expect(hit('spec:invalid', 0, 60)).rejects.toThrow();
  });

  it('is not tenant-scoped, because it runs before authentication', async () => {
    // `rate_limit_counters` is deliberately absent from the row-level security
    // table list: the auth bucket is keyed by username and IP at a point in the
    // request where no tenant is bound. A policy here would refuse every sign-in.
    const policies = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'rate_limit_counters'
    `;

    expect(Number(policies[0]?.count ?? 0)).toBe(0);
  });
});
