/**
 * The outbox worker process.
 *
 * Run one of these per deployment — or several; the claim is safe under
 * concurrency, which is the property migration 005 exists to establish.
 *
 *   npm run outbox:worker
 *
 * In a container, invoke `tsx scripts/outbox-worker.ts` directly rather than through
 * npm. npm does not forward SIGTERM to the script it spawns, so the shutdown below
 * never runs and the platform's grace period ends in a SIGKILL — with a batch of
 * events still claimed by a process that no longer exists. They are recoverable,
 * but only after the reclaim horizon and at the cost of an attempt each.
 *
 * It is a separate process rather than a timer inside the web server because the
 * two scale on different axes. Web instances come and go with request volume; the
 * dispatcher's throughput depends on the backlog, and running one copy per web
 * instance means the poll rate is set by traffic that has nothing to do with it.
 *
 * On a platform with no long-lived processes, do not run this. Call
 * `outboxRunner.tick()` from a scheduled request instead — it is the same pass.
 */

// Relative, not the `@/` alias: this runs under tsx, which does not resolve
// tsconfig paths. The seed generator imports the same way, for the same reason.
import { disconnectPrisma } from '../src/lib/infrastructure/db/prisma';
import {
  OutboxRunner,
  outboxRunnerOptionsFromEnv,
} from '../src/lib/infrastructure/events/outbox-runner';
import { logger } from '../src/lib/infrastructure/logging/logger';

const runner = new OutboxRunner();

/**
 * Shut down once, however many signals arrive.
 *
 * A container being replaced can receive SIGTERM and then SIGINT within a second.
 * Running the sequence twice would call `disconnectPrisma()` underneath a tick
 * that is still settling events.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Outbox worker shutting down', { signal });

  try {
    // Waits for the tick in flight, so claimed events are settled here rather
    // than left for the reclaim sweep to charge an attempt against.
    await runner.stop();
    await disconnectPrisma();
    logger.info('Outbox worker stopped cleanly', { stats: runner.stats });
    process.exit(0);
  } catch (error) {
    logger.error('Outbox worker failed to stop cleanly', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// An unhandled rejection in a background loop is a bug that would otherwise leave
// the process running and silently idle. Log it and let the platform restart us.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection in outbox worker', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
  void shutdown('unhandledRejection');
});

logger.info('Outbox worker starting', outboxRunnerOptionsFromEnv());
runner.start();
