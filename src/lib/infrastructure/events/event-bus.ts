import type {
  DomainEvent,
  DomainEventHandler,
  DomainEventType,
  TypedDomainEvent,
} from '@/lib/domain/shared/domain-event';
import { hostname } from 'node:os';
import type { TransactionClient } from '../db/prisma';
import { prisma } from '../db/prisma';
import { runInTenantScope } from '../db/tenant-scope';
import { logger } from '../logging/logger';

/**
 * Event-driven integration between modules, implemented as a transactional
 * outbox rather than an in-memory emitter.
 *
 * The problem with `emitter.emit()` inside a use case is that the event fires
 * whether or not the transaction commits. Post an invoice, publish
 * `invoice.posted`, then hit a constraint violation on the way out: the sale is
 * rolled back but inventory has already been decremented by a subscriber. Here,
 * events are INSERTed into `outbox_events` in the same transaction as the state
 * change, and dispatched only after it commits. A rolled-back transaction takes
 * its events down with it.
 */

type AnyHandler = (event: DomainEvent) => Promise<void> | void;

interface Subscription {
  readonly eventType: string;
  readonly handlerName: string;
  readonly handler: AnyHandler;
}

/** Attempts before an event is parked for a human instead of retried. */
const MAX_ATTEMPTS = 5;

export interface OutboxDrainReport {
  processed: number;
  failed: number;
  deadLettered: number;
  /** How many tenants had anything to dispatch. */
  tenants: number;
}

interface ClaimedEventRow {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly occurredAt: Date;
  readonly attempts: number;
}

/**
 * Identifies this process in a claim.
 *
 * Host and pid rather than a random id: when a claim is stuck, the useful question
 * is which container to inspect, and a uuid answers it only if something else has
 * already mapped uuids to containers. The random suffix separates two workers that
 * somehow share both.
 */
function buildWorkerId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${hostname()}/${process.pid}/${suffix}`.slice(0, 128);
}

class EventBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

  /** Stable for the life of the process, so a claim names the worker still holding it. */
  readonly workerId: string = buildWorkerId();

  /**
   * Registers a handler. `handlerName` appears in logs and in the dead-letter
   * record, so a failing subscriber can be identified without guesswork.
   */
  on<T extends DomainEventType>(
    eventType: T,
    handlerName: string,
    handler: DomainEventHandler<T>,
  ): void {
    const existing = this.subscriptions.get(eventType) ?? [];

    // Hot reload re-runs module top level; without this, handlers stack up and
    // a single event fires the same side effect five times.
    const deduplicated = existing.filter((entry) => entry.handlerName !== handlerName);
    deduplicated.push({
      eventType,
      handlerName,
      handler: handler as AnyHandler,
    });

    this.subscriptions.set(eventType, deduplicated);
  }

  /**
   * Persists events to the outbox inside the caller's transaction.
   * This is the only method a use case calls.
   */
  async enqueue(tx: TransactionClient, events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    // A use case that composes several services can end up holding the same
    // event twice — once from the service that raised it and once from its own
    // accumulated batch. Publishing it twice would run every subscriber twice;
    // failing the insert on the primary key would abort an otherwise valid
    // business transaction. Collapsing by event id is the only sane outcome.
    const unique = new Map<string, DomainEvent>();
    for (const event of events) {
      unique.set(event.eventId, event);
    }

    await tx.outboxEvent.createMany({
      data: [...unique.values()].map((event) => ({
        id: event.eventId,
        tenantId: event.metadata.tenantId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload as object,
        correlationId: event.metadata.correlationId,
        causationId: event.metadata.causationId ?? null,
        occurredAt: event.occurredAt,
      })),
    });
  }

  /**
   * Delivers one event to its subscribers.
   *
   * Handlers are isolated: one throwing does not prevent the others from
   * running, and the failure is reported so the event can be retried. A
   * subscriber that is down should not be able to stall an unrelated one.
   */
  async dispatch(event: DomainEvent): Promise<{ delivered: number; failures: string[] }> {
    const handlers = this.subscriptions.get(event.eventType) ?? [];
    const failures: string[] = [];
    let delivered = 0;

    for (const subscription of handlers) {
      try {
        await subscription.handler(event);
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${subscription.handlerName}: ${message}`);
        logger.error('Event handler failed', {
          eventType: event.eventType,
          eventId: event.eventId,
          handler: subscription.handlerName,
          error: message,
        });
      }
    }

    return { delivered, failures };
  }

  /**
   * Drains every active tenant's outbox.
   *
   * One pass per tenant, rather than one pass over the table, because
   * `outbox_events` is under a fail-closed row-level security policy: a session
   * with no tenant bound to it sees nothing at all. A cross-tenant sweep only
   * works while the application still connects as the table owner, which is a
   * deployment state migration 004 exists to end. Binding each tenant in turn
   * works under either role, which is the point.
   *
   * `batchSize` is per tenant. A tenant with a backlog cannot starve the others
   * within a tick, and the next tick picks up where this one stopped.
   */
  async drainOutbox(batchSize = 100): Promise<OutboxDrainReport> {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    const report: OutboxDrainReport = { processed: 0, failed: 0, deadLettered: 0, tenants: 0 };

    for (const tenant of tenants) {
      const tenantReport = await this.drainTenant(tenant.id, batchSize);
      report.processed += tenantReport.processed;
      report.failed += tenantReport.failed;
      report.deadLettered += tenantReport.deadLettered;
      if (tenantReport.processed > 0 || tenantReport.failed > 0) report.tenants += 1;
    }

    return report;
  }

  /**
   * Drains one tenant's outbox.
   *
   * Three phases, and the separation between them is the whole design:
   *
   *   1. Claim, in one statement. `FOR UPDATE SKIP LOCKED` inside an `UPDATE`
   *      subquery holds its locks for exactly as long as the statement that writes
   *      the claim, so two workers cannot take the same row and neither waits on
   *      the other.
   *   2. Dispatch, outside any transaction. Handlers do I/O; a transaction held
   *      open across a network call holds a snapshot, its locks and one connection
   *      from a pool of twenty for as long as the slowest subscriber takes.
   *   3. Settle. Success stamps `processedAt`; failure releases the claim so the
   *      next tick retries it.
   *
   * The claim is what survives phase 2 — which is precisely what a row lock could
   * not do, and why the previous implementation's `FOR UPDATE SKIP LOCKED` in a
   * standalone `SELECT` protected nothing: the lock was gone before the first
   * handler ran.
   *
   * The `tenantId` predicate is explicit rather than left to the row-level security
   * policy, and that is not redundancy for its own sake: PostgreSQL exempts a
   * table's owner from its own policies, and this application still connects as the
   * owner — deliberately, until every read path is scoped (see `.env.example`).
   * Under that role a policy-only filter selects every tenant's events, so the
   * predicate is the control here and the policy is the backstop.
   */
  async drainTenant(tenantId: string, batchSize = 100): Promise<OutboxDrainReport> {
    return runInTenantScope({ tenantId }, async () => {
      const claimed = await prisma.$queryRaw<ClaimedEventRow[]>`
        UPDATE "outbox_events"
           SET "claimedAt" = now(),
               "claimedBy" = ${this.workerId}
         WHERE "id" IN (
                 SELECT "id"
                   FROM "outbox_events"
                  WHERE "tenantId" = ${tenantId}::uuid
                    AND "processedAt" IS NULL
                    AND NOT "deadLettered"
                    AND "claimedAt" IS NULL
                  ORDER BY "occurredAt"
                  LIMIT ${batchSize}
                    FOR UPDATE SKIP LOCKED
               )
        RETURNING "id", "tenantId", "eventType", "aggregateType", "aggregateId",
                  "payload", "correlationId", "causationId", "occurredAt", "attempts"
      `;

      const report: OutboxDrainReport = {
        processed: 0,
        failed: 0,
        deadLettered: 0,
        tenants: claimed.length > 0 ? 1 : 0,
      };

      // Claimed rows come back in whatever order the UPDATE wrote them; events
      // for one aggregate must be delivered in the order they occurred, or a
      // `posted` handler can run before the `created` one it depends on.
      claimed.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

      for (const row of claimed) {
        const event: DomainEvent = {
          eventId: row.id,
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          occurredAt: row.occurredAt,
          payload: row.payload,
          metadata: {
            correlationId: row.correlationId ?? row.id,
            ...(row.causationId !== null ? { causationId: row.causationId } : {}),
            tenantId: row.tenantId,
          },
        };

        const result = await this.dispatch(event);

        if (result.failures.length === 0) {
          await prisma.outboxEvent.update({
            where: { id: row.id },
            data: { processedAt: new Date(), lastError: null, claimedAt: null, claimedBy: null },
          });
          report.processed += 1;
          continue;
        }

        const settled = await this.recordFailure(
          row.id,
          row.attempts + 1,
          result.failures.join('; '),
        );

        report.failed += 1;
        if (settled.deadLettered) {
          report.deadLettered += 1;
          logger.error('Event dead-lettered after repeated failures', {
            eventId: row.id,
            eventType: row.eventType,
            attempts: settled.attempts,
          });
        }
      }

      return report;
    });
  }

  /**
   * Releases claims held by workers that are no longer running.
   *
   * A process killed between claiming and settling leaves rows marked in flight
   * with nothing in flight. Without this they are never retried and never
   * dead-lettered — they simply stop, which is the failure mode hardest to notice.
   *
   * The reclaim counts an attempt. An event whose handler crashes the worker would
   * otherwise be claimed, orphaned and reclaimed forever; charging it an attempt
   * means a genuinely poisonous event reaches the dead-letter cap and stops.
   */
  async reclaimStaleClaims(
    tenantId: string,
    olderThanSeconds: number,
  ): Promise<{ reclaimed: number; deadLettered: number }> {
    return runInTenantScope({ tenantId }, async () => {
      const rows = await prisma.$queryRaw<{ id: string; attempts: number }[]>`
        UPDATE "outbox_events"
           SET "claimedAt" = NULL,
               "claimedBy" = NULL,
               "attempts" = "attempts" + 1,
               "deadLettered" = ("attempts" + 1) >= ${MAX_ATTEMPTS},
               "lastError" = ${'Reclaimed: the worker holding this event stopped before settling it.'}
         WHERE "tenantId" = ${tenantId}::uuid
           AND "processedAt" IS NULL
           AND NOT "deadLettered"
           AND "claimedAt" IS NOT NULL
           AND "claimedAt" < now() - make_interval(secs => ${olderThanSeconds}::int)
        RETURNING "id", "attempts"
      `;

      const deadLettered = rows.filter((row) => row.attempts >= MAX_ATTEMPTS).length;

      if (rows.length > 0) {
        logger.warn('Reclaimed abandoned outbox claims', {
          tenantId,
          reclaimed: rows.length,
          deadLettered,
        });
      }

      return { reclaimed: rows.length, deadLettered };
    });
  }

  /** Reclaims across every active tenant. */
  async reclaimAllStaleClaims(
    olderThanSeconds: number,
  ): Promise<{ reclaimed: number; deadLettered: number }> {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    let reclaimed = 0;
    let deadLettered = 0;

    for (const tenant of tenants) {
      const result = await this.reclaimStaleClaims(tenant.id, olderThanSeconds);
      reclaimed += result.reclaimed;
      deadLettered += result.deadLettered;
    }

    return { reclaimed, deadLettered };
  }

  /**
   * Records a failed delivery and releases the claim.
   *
   * The claim is cleared rather than left in place: a failed event is not in
   * flight, and leaving it claimed would hide it from the next tick until the
   * reclaim horizon passed.
   */
  private async recordFailure(
    eventId: string,
    attempts: number,
    error: string,
  ): Promise<{ attempts: number; deadLettered: boolean }> {
    // Five attempts, then the event is parked for a human rather than retried
    // forever against a bug that is not going to fix itself.
    const deadLettered = attempts >= MAX_ATTEMPTS;

    await prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        attempts,
        lastError: error.slice(0, 2000),
        deadLettered,
        claimedAt: null,
        claimedBy: null,
      },
    });

    return { attempts, deadLettered };
  }

  /** Introspection for the health endpoint and for tests. */
  get registeredHandlers(): { eventType: string; handlers: string[] }[] {
    return [...this.subscriptions.entries()].map(([eventType, subs]) => ({
      eventType,
      handlers: subs.map((sub) => sub.handlerName),
    }));
  }

  /** Test seam — clears every subscription. */
  reset(): void {
    this.subscriptions.clear();
  }
}

const globalForBus = globalThis as unknown as { eventBus: EventBus | undefined };

export const eventBus: EventBus = globalForBus.eventBus ?? new EventBus();

if (process.env.NODE_ENV !== 'production') {
  globalForBus.eventBus = eventBus;
}

/** Narrowing helper so a handler body receives a fully typed payload. */
export function isEventOfType<T extends DomainEventType>(
  event: DomainEvent,
  eventType: T,
): event is TypedDomainEvent<T> {
  return event.eventType === eventType;
}
