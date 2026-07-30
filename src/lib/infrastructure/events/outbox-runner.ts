import { eventBus, type OutboxDrainReport } from './event-bus';
import { sweepIdempotencyRecords } from '@/lib/api/idempotency';
import { logger } from '../logging/logger';
import { sweepRateLimits } from '../security/rate-limit';

/**
 * The scheduler the outbox never had.
 *
 * `drainOutbox()` was correct and nothing called it, which meant asynchronous
 * subscribers ran only when a request happened to trigger a drain — that is, never.
 * This turns it into a process: poll, dispatch, settle, repeat.
 *
 * What a timer has to get right, and what a bare `setInterval` gets wrong:
 *
 *   - **No overlap.** A tick that outlasts the interval must not have a second one
 *     start beside it. `setInterval` does exactly that, and two ticks in the same
 *     process claim disjoint batches and then compete for the same connections.
 *     The interval here is re-armed *after* each tick finishes.
 *   - **Jitter.** N replicas started by the same rollout poll in lockstep, so the
 *     database sees N simultaneous claim statements every interval and nothing in
 *     between. A random offset per tick spreads them.
 *   - **A tick that throws is not the end of the runner.** A failed poll — the
 *     database restarting, say — must be logged and retried on the next tick, not
 *     allowed to kill the loop and leave a process alive with nothing scheduled.
 *   - **Graceful stop.** On SIGTERM the in-flight tick finishes before the process
 *     exits, so claimed events are settled rather than orphaned for the reclaim
 *     sweep to find.
 */

export interface OutboxRunnerOptions {
  /** Milliseconds between the end of one tick and the start of the next. */
  readonly intervalMs?: number;
  /** Events claimed per tenant per tick. */
  readonly batchSize?: number;
  /**
   * How long a claim may sit before it is treated as abandoned. Must exceed the
   * slowest realistic dispatch, or a tick still running will have its own work
   * reclaimed underneath it.
   */
  readonly reclaimAfterSeconds?: number;
  /** How many ticks between reclaim sweeps. Recovery, not the hot path. */
  readonly reclaimEveryTicks?: number;
  /** How many ticks between rate-limit and idempotency sweeps. */
  readonly sweepEveryTicks?: number;
  /**
   * How long an idempotency record is kept.
   *
   * It only has to outlive the window in which a client might retry under the same key.
   * Too short and a replay after a long outage creates a duplicate; too long and the
   * table grows by one row per mutation indefinitely. A day covers a laptop that was
   * shut overnight, which is the case the offline queue exists for.
   */
  readonly idempotencyTtlSeconds?: number;
  /** Upper bound on the random delay added to each interval. */
  readonly jitterMs?: number;
}

const DEFAULTS = {
  intervalMs: 5_000,
  batchSize: 100,
  reclaimAfterSeconds: 300,
  reclaimEveryTicks: 12,
  sweepEveryTicks: 60,
  idempotencyTtlSeconds: 86_400,
  jitterMs: 1_000,
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Options from the environment, so a deployment tunes the loop without a rebuild. */
export function outboxRunnerOptionsFromEnv(): Required<OutboxRunnerOptions> {
  return {
    intervalMs: positiveInt(process.env['OUTBOX_POLL_INTERVAL_MS'], DEFAULTS.intervalMs),
    batchSize: positiveInt(process.env['OUTBOX_BATCH_SIZE'], DEFAULTS.batchSize),
    reclaimAfterSeconds: positiveInt(
      process.env['OUTBOX_RECLAIM_AFTER_SECONDS'],
      DEFAULTS.reclaimAfterSeconds,
    ),
    reclaimEveryTicks: positiveInt(
      process.env['OUTBOX_RECLAIM_EVERY_TICKS'],
      DEFAULTS.reclaimEveryTicks,
    ),
    sweepEveryTicks: positiveInt(
      process.env['OUTBOX_SWEEP_EVERY_TICKS'],
      DEFAULTS.sweepEveryTicks,
    ),
    idempotencyTtlSeconds: positiveInt(
      process.env['IDEMPOTENCY_TTL_SECONDS'],
      DEFAULTS.idempotencyTtlSeconds,
    ),
    jitterMs: positiveInt(process.env['OUTBOX_JITTER_MS'], DEFAULTS.jitterMs),
  };
}

export interface OutboxRunnerStats {
  readonly ticks: number;
  readonly processed: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly reclaimed: number;
  readonly tickErrors: number;
  readonly running: boolean;
  readonly lastTickAt: Date | null;
}

export class OutboxRunner {
  private readonly options: Required<OutboxRunnerOptions>;

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** The in-flight tick, so `stop()` can wait for it rather than cut it off. */
  private inFlight: Promise<void> | undefined;

  private ticks = 0;
  private processed = 0;
  private failed = 0;
  private deadLettered = 0;
  private reclaimed = 0;
  private tickErrors = 0;
  private lastTickAt: Date | null = null;

  constructor(options: OutboxRunnerOptions = {}) {
    this.options = { ...outboxRunnerOptionsFromEnv(), ...stripUndefined(options) };
  }

  /** Idempotent: starting a running runner is a no-op, not a second loop. */
  start(): void {
    if (this.running) return;
    this.running = true;

    logger.info('Outbox runner started', {
      workerId: eventBus.workerId,
      intervalMs: this.options.intervalMs,
      batchSize: this.options.batchSize,
    });

    this.scheduleNext(0);
  }

  /**
   * Stops polling and waits for the tick in progress.
   *
   * Awaiting `inFlight` is the difference between a clean shutdown and a batch of
   * events left claimed by a process that no longer exists — recoverable, but only
   * after the reclaim horizon, and at the cost of an attempt against each event.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.inFlight;
    logger.info('Outbox runner stopped', { workerId: eventBus.workerId, ticks: this.ticks });
  }

  /**
   * One pass. Public so a serverless deployment, which cannot host a long-lived
   * loop, can invoke exactly this from a scheduled request, and so tests can drive
   * the work without a timer.
   */
  async tick(): Promise<OutboxDrainReport> {
    this.ticks += 1;
    this.lastTickAt = new Date();

    if (this.ticks % this.options.reclaimEveryTicks === 0) {
      const result = await eventBus.reclaimAllStaleClaims(this.options.reclaimAfterSeconds);
      this.reclaimed += result.reclaimed;
      this.deadLettered += result.deadLettered;
    }

    // The shared rate-limit counters have no other scheduled process to sweep
    // them, and one row per client IP grows without bound. This loop is already
    // the deployment's answer to "something that runs on a timer".
    if (this.ticks % this.options.sweepEveryTicks === 0) {
      const swept = await sweepRateLimits();
      if (swept > 0) logger.debug('Swept rate limit counters', { swept });

      // Same argument: one row per keyed mutation, and no other scheduled process to
      // discard them.
      const keys = await sweepIdempotencyRecords(this.options.idempotencyTtlSeconds);
      if (keys > 0) logger.debug('Swept idempotency records', { swept: keys });
    }

    const report = await eventBus.drainOutbox(this.options.batchSize);

    this.processed += report.processed;
    this.failed += report.failed;
    this.deadLettered += report.deadLettered;

    if (report.processed > 0 || report.failed > 0) {
      logger.info('Outbox drained', {
        workerId: eventBus.workerId,
        processed: report.processed,
        failed: report.failed,
        deadLettered: report.deadLettered,
        tenants: report.tenants,
      });
    }

    return report;
  }

  get stats(): OutboxRunnerStats {
    return {
      ticks: this.ticks,
      processed: this.processed,
      failed: this.failed,
      deadLettered: this.deadLettered,
      reclaimed: this.reclaimed,
      tickErrors: this.tickErrors,
      running: this.running,
      lastTickAt: this.lastTickAt,
    };
  }

  /**
   * Arms the next tick.
   *
   * `setTimeout` re-armed on completion, not `setInterval`: the contract is a gap
   * of `intervalMs` between ticks, which is what keeps a slow tick from being
   * overlapped by the next one.
   */
  private scheduleNext(delayMs: number): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      this.inFlight = this.runTick();
      void this.inFlight.finally(() => {
        this.inFlight = undefined;
        this.scheduleNext(this.options.intervalMs + Math.random() * this.options.jitterMs);
      });
    }, delayMs);

    // Deliberately *not* `unref()`ed. A pending poll is the only handle a
    // dedicated worker process holds between ticks, so unreferencing it lets the
    // event loop drain and the process exit moments after its first drain — a
    // daemon that runs once and stops. `stop()` clears the timer explicitly, which
    // is what allows a clean exit; nothing here needs to rely on unref for that.
  }

  private async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.tickErrors += 1;
      // Swallowed on purpose. A tick fails for reasons that pass — a database
      // restart, a pool exhausted by a spike — and a scheduler that dies on the
      // first of them leaves a live process with nothing scheduled, which is worse
      // than a logged error and a retry in five seconds.
      logger.error('Outbox tick failed', {
        workerId: eventBus.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

const globalForRunner = globalThis as unknown as { outboxRunner: OutboxRunner | undefined };

/** The process-wide runner. One loop per process, however many modules ask for it. */
export const outboxRunner: OutboxRunner = globalForRunner.outboxRunner ?? new OutboxRunner();

if (process.env.NODE_ENV !== 'production') {
  globalForRunner.outboxRunner = outboxRunner;
}
