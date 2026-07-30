import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scheduler, without a database.
 *
 * What is being tested is the loop, not the dispatch: that a slow tick is never
 * overlapped by the next one, that a failed tick does not end the runner, that
 * stopping waits for work in flight, and that the recovery passes run on their
 * stated cadence rather than every tick.
 *
 * These are the properties a bare `setInterval` gets wrong, and none of them are
 * visible in a test that drives `tick()` by hand — so this file drives the timer.
 */

const drainOutbox = vi.fn();
const reclaimAllStaleClaims = vi.fn();
const sweepRateLimits = vi.fn();
const sweepIdempotencyRecords = vi.fn();

vi.mock('@/lib/infrastructure/events/event-bus', () => ({
  eventBus: {
    workerId: 'test-worker',
    drainOutbox: (...args: unknown[]) => drainOutbox(...args) as unknown,
    reclaimAllStaleClaims: (...args: unknown[]) => reclaimAllStaleClaims(...args) as unknown,
  },
}));

vi.mock('@/lib/infrastructure/security/rate-limit', () => ({
  sweepRateLimits: () => sweepRateLimits() as unknown,
}));

vi.mock('@/lib/api/idempotency', () => ({
  sweepIdempotencyRecords: (...args: unknown[]) => sweepIdempotencyRecords(...args) as unknown,
}));

vi.mock('@/lib/infrastructure/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { OutboxRunner, outboxRunnerOptionsFromEnv } = await import(
  '@/lib/infrastructure/events/outbox-runner'
);

const emptyReport = { processed: 0, failed: 0, deadLettered: 0, tenants: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  drainOutbox.mockReset().mockResolvedValue(emptyReport);
  reclaimAllStaleClaims.mockReset().mockResolvedValue({ reclaimed: 0, deadLettered: 0 });
  sweepRateLimits.mockReset().mockResolvedValue(0);
  sweepIdempotencyRecords.mockReset().mockResolvedValue(0);
});

afterEach(() => {
  delete process.env['OUTBOX_POLL_INTERVAL_MS'];
  delete process.env['OUTBOX_BATCH_SIZE'];
});

describe('OutboxRunner.tick', () => {
  it('accumulates what each drain reported', async () => {
    drainOutbox.mockResolvedValue({ processed: 3, failed: 1, deadLettered: 1, tenants: 2 });
    const runner = new OutboxRunner();

    await runner.tick();
    await runner.tick();

    expect(runner.stats.processed).toBe(6);
    expect(runner.stats.failed).toBe(2);
    expect(runner.stats.deadLettered).toBe(2);
    expect(runner.stats.ticks).toBe(2);
  });

  it('passes the configured batch size through to the drain', async () => {
    const runner = new OutboxRunner({ batchSize: 7 });

    await runner.tick();

    expect(drainOutbox).toHaveBeenCalledWith(7);
  });

  it('reclaims on its own cadence rather than every tick', async () => {
    const runner = new OutboxRunner({ reclaimEveryTicks: 3, reclaimAfterSeconds: 90 });

    await runner.tick();
    await runner.tick();
    expect(reclaimAllStaleClaims).not.toHaveBeenCalled();

    await runner.tick();

    expect(reclaimAllStaleClaims).toHaveBeenCalledTimes(1);
    expect(reclaimAllStaleClaims).toHaveBeenCalledWith(90);
  });

  it('counts events dead-lettered by a reclaim, not only by a failed dispatch', async () => {
    // A worker killed mid-dispatch leaves a claim behind; the reclaim charges an
    // attempt, and the fifth of those is what stops a poison event cycling forever.
    reclaimAllStaleClaims.mockResolvedValue({ reclaimed: 4, deadLettered: 2 });
    const runner = new OutboxRunner({ reclaimEveryTicks: 1 });

    await runner.tick();

    expect(runner.stats.reclaimed).toBe(4);
    expect(runner.stats.deadLettered).toBe(2);
  });

  it('sweeps the shared rate-limit counters on its own cadence', async () => {
    const runner = new OutboxRunner({ sweepEveryTicks: 2 });

    await runner.tick();
    expect(sweepRateLimits).not.toHaveBeenCalled();

    await runner.tick();

    expect(sweepRateLimits).toHaveBeenCalledTimes(1);
  });

  it('sweeps idempotency records on the same cadence, with the configured TTL', async () => {
    // Both sweeps ride the same tick counter: they exist for the same reason — a table
    // that grows by one row per request with no other scheduled process to trim it.
    const runner = new OutboxRunner({ sweepEveryTicks: 2, idempotencyTtlSeconds: 3600 });

    await runner.tick();
    expect(sweepIdempotencyRecords).not.toHaveBeenCalled();

    await runner.tick();

    expect(sweepIdempotencyRecords).toHaveBeenCalledWith(3600);
  });
});

describe('OutboxRunner scheduling', () => {
  it('never overlaps two ticks, however slow one is', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    drainOutbox.mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Deliberately longer than the interval: this is the case `setInterval`
      // gets wrong, starting a second tick beside the first.
      await sleep(60);
      concurrent -= 1;
      return emptyReport;
    });

    const runner = new OutboxRunner({ intervalMs: 10, jitterMs: 1 });
    runner.start();
    await sleep(300);
    await runner.stop();

    expect(maxConcurrent).toBe(1);
    expect(runner.stats.ticks).toBeGreaterThan(1);
  });

  it('keeps polling after a tick throws', async () => {
    drainOutbox
      .mockRejectedValueOnce(new Error('database restarting'))
      .mockResolvedValue(emptyReport);

    const runner = new OutboxRunner({ intervalMs: 10, jitterMs: 1 });
    runner.start();
    await sleep(120);
    await runner.stop();

    expect(runner.stats.tickErrors).toBe(1);
    // The loop survived the failure rather than leaving a live process with
    // nothing scheduled.
    expect(runner.stats.ticks).toBeGreaterThan(1);
  });

  it('is idempotent to start, so two callers do not create two loops', async () => {
    const runner = new OutboxRunner({ intervalMs: 20, jitterMs: 1 });

    runner.start();
    runner.start();
    await sleep(70);
    await runner.stop();

    const ticks = runner.stats.ticks;
    // Two loops in one process would roughly double this. Allow slack for timer
    // scheduling, but not enough to hide a duplicate loop.
    expect(ticks).toBeLessThanOrEqual(5);
  });

  it('waits for the tick in flight before reporting itself stopped', async () => {
    let settled = false;

    drainOutbox.mockImplementation(async () => {
      await sleep(80);
      settled = true;
      return emptyReport;
    });

    const runner = new OutboxRunner({ intervalMs: 5, jitterMs: 1 });
    runner.start();
    await sleep(20);

    await runner.stop();

    // If `stop()` returned early, the claimed batch would be left unsettled for
    // the reclaim sweep to find — and charged an attempt it did not earn.
    expect(settled).toBe(true);
    expect(runner.stats.running).toBe(false);
  });

  it('stops polling once stopped', async () => {
    const runner = new OutboxRunner({ intervalMs: 10, jitterMs: 1 });
    runner.start();
    await sleep(50);
    await runner.stop();

    const ticksAtStop = runner.stats.ticks;
    await sleep(60);

    expect(runner.stats.ticks).toBe(ticksAtStop);
  });

  it('stopping a runner that never started is not an error', async () => {
    await expect(new OutboxRunner().stop()).resolves.toBeUndefined();
  });
});

describe('outboxRunnerOptionsFromEnv', () => {
  it('reads the environment', () => {
    process.env['OUTBOX_POLL_INTERVAL_MS'] = '250';
    process.env['OUTBOX_BATCH_SIZE'] = '25';

    const options = outboxRunnerOptionsFromEnv();

    expect(options.intervalMs).toBe(250);
    expect(options.batchSize).toBe(25);
  });

  it('falls back to the defaults rather than to zero or NaN', () => {
    // A misconfigured interval of "0" or "abc" would otherwise produce a loop that
    // polls as fast as the event loop allows.
    process.env['OUTBOX_POLL_INTERVAL_MS'] = '0';
    process.env['OUTBOX_BATCH_SIZE'] = 'abc';

    const options = outboxRunnerOptionsFromEnv();

    expect(options.intervalMs).toBeGreaterThan(0);
    expect(options.batchSize).toBeGreaterThan(0);
  });

  it('lets an explicit option win over the environment', async () => {
    process.env['OUTBOX_BATCH_SIZE'] = '25';

    await new OutboxRunner({ batchSize: 99 }).tick();

    expect(drainOutbox).toHaveBeenCalledWith(99);
  });

  it('takes the environment for options left unspecified', async () => {
    process.env['OUTBOX_BATCH_SIZE'] = '25';

    // `intervalMs` is explicit, `batchSize` is not — the constructor must merge
    // rather than replace, or one override silently discards the rest.
    await new OutboxRunner({ intervalMs: 999 }).tick();

    expect(drainOutbox).toHaveBeenCalledWith(25);
  });
});
