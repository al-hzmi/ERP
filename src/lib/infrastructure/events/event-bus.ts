import type {
  DomainEvent,
  DomainEventHandler,
  DomainEventType,
  TypedDomainEvent,
} from '@/lib/domain/shared/domain-event';
import type { TransactionClient } from '../db/prisma';
import { prisma } from '../db/prisma';
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

class EventBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

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

    await tx.outboxEvent.createMany({
      data: events.map((event) => ({
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
   * Drains the outbox.
   *
   * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several dispatcher
   * instances can run concurrently without processing the same event twice and
   * without blocking each other.
   */
  async drainOutbox(batchSize = 100): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;

    const claimed = await prisma.$queryRaw<
      {
        id: string;
        tenantId: string;
        eventType: string;
        aggregateType: string;
        aggregateId: string;
        payload: Record<string, unknown>;
        correlationId: string | null;
        causationId: string | null;
        occurredAt: Date;
        attempts: number;
      }[]
    >`
      SELECT "id", "tenantId", "eventType", "aggregateType", "aggregateId",
             "payload", "correlationId", "causationId", "occurredAt", "attempts"
        FROM "outbox_events"
       WHERE "processedAt" IS NULL
         AND NOT "deadLettered"
       ORDER BY "occurredAt"
       LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED
    `;

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
          data: { processedAt: new Date(), lastError: null },
        });
        processed += 1;
        continue;
      }

      // Five attempts, then the event is parked for a human rather than retried
      // forever against a bug that is not going to fix itself.
      const attempts = row.attempts + 1;
      const deadLettered = attempts >= 5;

      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: result.failures.join('; ').slice(0, 2000),
          deadLettered,
        },
      });

      failed += 1;

      if (deadLettered) {
        logger.error('Event dead-lettered after repeated failures', {
          eventId: row.id,
          eventType: row.eventType,
          attempts,
        });
      }
    }

    return { processed, failed };
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
