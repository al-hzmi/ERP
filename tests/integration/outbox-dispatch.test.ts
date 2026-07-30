import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eventBus } from '@/lib/infrastructure/events/event-bus';

/**
 * The outbox dispatcher, against a real database.
 *
 * The bug this file exists to hold closed: `drainOutbox()` claimed rows with
 * `FOR UPDATE SKIP LOCKED` inside a *standalone* `SELECT`. A row lock lives
 * exactly as long as the transaction that took it, and a standalone statement
 * commits when it returns — so the lock was released before the first handler ran,
 * and two dispatchers polling the same table both "claimed" the same events and
 * both delivered them. The code carried a comment promising concurrency safety it
 * did not have, which is the kind of defect a test suite is for.
 *
 * Proving the fix needs real concurrency against real MVCC. There is no version of
 * this that a stubbed client demonstrates.
 */

const databaseUrl = process.env['DATABASE_URL'];
const hasDatabase = databaseUrl !== undefined && databaseUrl !== '';

const prisma = new PrismaClient();

const tenantCode = 'OUTBOX_SPEC';
let tenantId = '';

async function ensureTenant(): Promise<string> {
  const tenant = await prisma.tenant.upsert({
    where: { code: tenantCode },
    update: {},
    create: { code: tenantCode, nameAr: 'مستأجر الاختبار', nameEn: 'Outbox spec tenant' },
    select: { id: true },
  });
  return tenant.id;
}

async function insertEvents(count: number, forTenant = tenantId): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());

  await prisma.outboxEvent.createMany({
    data: ids.map((id, index) => ({
      id,
      tenantId: forTenant,
      eventType: 'sales.invoice.posted',
      aggregateType: 'Document',
      aggregateId: `doc-${index}`,
      payload: { index },
      // Distinct timestamps so ordering assertions are meaningful.
      occurredAt: new Date(Date.now() + index),
    })),
  });

  return ids;
}

/**
 * The claim statement the dispatcher issues, as a second concurrent worker.
 *
 * Kept byte-for-byte equivalent to the one in `drainTenant`, tenant predicate
 * included. Without that predicate this connects as the owner — which PostgreSQL
 * exempts from the policy — and sweeps up whatever other suites have left in
 * `outbox_events`, which is a flaky assertion rather than a demonstration.
 */
async function rivalClaim(workerId: string, batchSize: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "outbox_events"
       SET "claimedAt" = now(), "claimedBy" = ${workerId}
     WHERE "id" IN (
             SELECT "id" FROM "outbox_events"
              WHERE "tenantId" = ${tenantId}::uuid
                AND "processedAt" IS NULL AND NOT "deadLettered" AND "claimedAt" IS NULL
              ORDER BY "occurredAt" LIMIT ${batchSize}
                FOR UPDATE SKIP LOCKED
           )
    RETURNING "id"
  `;
  return rows.map((row) => row.id);
}

describe.skipIf(!hasDatabase)('outbox dispatch', () => {
  beforeEach(async () => {
    tenantId = await ensureTenant();
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    eventBus.reset();
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { code: tenantCode } });
    await prisma.$disconnect();
  });

  it('delivers a pending event to its subscriber and marks it processed', async () => {
    const seen: string[] = [];
    eventBus.on('sales.invoice.posted', 'spec.collect', (event) => {
      seen.push(event.eventId);
    });
    const [id] = await insertEvents(1);

    const report = await eventBus.drainTenant(tenantId);

    expect(report.processed).toBe(1);
    expect(seen).toEqual([id]);

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
    expect(row.processedAt).not.toBeNull();
    // The claim is released on success as well as on failure; a processed row that
    // stays claimed is invisible to the reclaim sweep and to an operator reading it.
    expect(row.claimedAt).toBeNull();
  });

  it('does not deliver an event twice across drains', async () => {
    let deliveries = 0;
    eventBus.on('sales.invoice.posted', 'spec.count', () => {
      deliveries += 1;
    });
    await insertEvents(3);

    await eventBus.drainTenant(tenantId);
    await eventBus.drainTenant(tenantId);

    expect(deliveries).toBe(3);
  });

  it('never lets two concurrent workers claim the same event', async () => {
    // The regression test for the original defect. Under the old standalone
    // `SELECT ... FOR UPDATE SKIP LOCKED`, every rival here returned the *same*
    // rows: 8 workers x 10 rows = 80 claims over 50 events.
    await insertEvents(50);

    const batches = await Promise.all(
      Array.from({ length: 8 }, (_, index) => rivalClaim(`rival-${index}`, 10)),
    );

    const claimed = batches.flat();
    expect(claimed).toHaveLength(50);
    expect(new Set(claimed).size).toBe(50);
  });

  it('dispatches in the order events occurred', async () => {
    // A `posted` handler that runs before the `created` it depends on is a bug the
    // claim order can cause on its own: the UPDATE returns rows in whatever order
    // it wrote them, not in `occurredAt` order.
    const order: number[] = [];
    eventBus.on('sales.invoice.posted', 'spec.order', (event) => {
      // The payload is typed for the real `sales.invoice.posted` event; these rows
      // carry a bare index instead, which is what the ordering assertion reads.
      order.push((event.payload as unknown as { index: number }).index);
    });
    await insertEvents(12);

    await eventBus.drainTenant(tenantId);

    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order).toHaveLength(12);
  });

  it('respects the batch size, leaving the rest for the next tick', async () => {
    eventBus.on('sales.invoice.posted', 'spec.noop', () => undefined);
    await insertEvents(10);

    const first = await eventBus.drainTenant(tenantId, 4);

    expect(first.processed).toBe(4);
    expect(await prisma.outboxEvent.count({ where: { tenantId, processedAt: null } })).toBe(6);
  });

  it('releases the claim and records the error when a handler throws', async () => {
    eventBus.on('sales.invoice.posted', 'spec.throws', () => {
      throw new Error('subscriber exploded');
    });
    const [id] = await insertEvents(1);

    const report = await eventBus.drainTenant(tenantId);

    expect(report.failed).toBe(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('subscriber exploded');
    expect(row.processedAt).toBeNull();
    // Cleared, so the next tick retries it rather than waiting out the reclaim
    // horizon on a row that is not actually in flight.
    expect(row.claimedAt).toBeNull();
    expect(row.deadLettered).toBe(false);
  });

  it('isolates handlers: one throwing does not stop the others', async () => {
    let reached = false;
    eventBus.on('sales.invoice.posted', 'spec.first', () => {
      throw new Error('first fails');
    });
    eventBus.on('sales.invoice.posted', 'spec.second', () => {
      reached = true;
    });
    await insertEvents(1);

    await eventBus.drainTenant(tenantId);

    expect(reached).toBe(true);
  });

  it('dead-letters after five attempts rather than retrying a bug forever', async () => {
    eventBus.on('sales.invoice.posted', 'spec.always-fails', () => {
      throw new Error('still broken');
    });
    const [id] = await insertEvents(1);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await eventBus.drainTenant(tenantId);
    }

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
    expect(row.attempts).toBe(5);
    expect(row.deadLettered).toBe(true);

    // And is then left alone: a dead-lettered event is a human's problem.
    const after = await eventBus.drainTenant(tenantId);
    expect(after.failed).toBe(0);
    expect(after.processed).toBe(0);
  });

  it('reclaims a claim abandoned by a worker that stopped', async () => {
    const [id] = await insertEvents(1);
    // A worker that was killed between claiming and settling.
    await prisma.outboxEvent.update({
      where: { id: id! },
      data: { claimedAt: new Date(Date.now() - 600_000), claimedBy: 'dead-worker/1' },
    });

    // Invisible until reclaimed — which is the failure mode worth naming: the event
    // is neither retried nor dead-lettered, it simply stops.
    expect((await eventBus.drainTenant(tenantId)).processed).toBe(0);

    const result = await eventBus.reclaimStaleClaims(tenantId, 300);

    expect(result.reclaimed).toBe(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
    expect(row.claimedAt).toBeNull();
    // Charged an attempt, so an event whose handler kills its worker eventually
    // dead-letters instead of being reclaimed forever.
    expect(row.attempts).toBe(1);
  });

  it('leaves a fresh claim alone, so a tick in flight is not undercut', async () => {
    const [id] = await insertEvents(1);
    await prisma.outboxEvent.update({
      where: { id: id! },
      data: { claimedAt: new Date(), claimedBy: 'busy-worker/1' },
    });

    const result = await eventBus.reclaimStaleClaims(tenantId, 300);

    expect(result.reclaimed).toBe(0);
  });

  it('dead-letters an event that keeps outliving its worker', async () => {
    const [id] = await insertEvents(1);
    await prisma.outboxEvent.update({
      where: { id: id! },
      data: { attempts: 4, claimedAt: new Date(Date.now() - 600_000), claimedBy: 'dead/1' },
    });

    const result = await eventBus.reclaimStaleClaims(tenantId, 300);

    expect(result.deadLettered).toBe(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
    expect(row.deadLettered).toBe(true);
  });

  it('an event with no subscriber is processed, not left pending forever', async () => {
    // Nothing is registered for this type. Treating "no handler" as a failure would
    // dead-letter every event the deployment does not happen to subscribe to.
    const [id] = await insertEvents(1);

    const report = await eventBus.drainTenant(tenantId);

    expect(report.processed).toBe(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id! } });
    expect(row.processedAt).not.toBeNull();
  });

  it('drains each tenant separately, and never across them', async () => {
    const other = await prisma.tenant.upsert({
      where: { code: `${tenantCode}_2` },
      update: {},
      create: { code: `${tenantCode}_2`, nameAr: 'آخر', nameEn: 'Other' },
      select: { id: true },
    });

    try {
      await prisma.outboxEvent.deleteMany({ where: { tenantId: other.id } });
      const seen: string[] = [];
      eventBus.on('sales.invoice.posted', 'spec.tenant', (event) => {
        seen.push(event.metadata.tenantId);
      });

      await insertEvents(2, tenantId);
      await insertEvents(3, other.id);

      const report = await eventBus.drainTenant(tenantId);

      expect(report.processed).toBe(2);
      expect(new Set(seen)).toEqual(new Set([tenantId]));
      // The other tenant's events are untouched, which is what makes the
      // per-tenant loop safe under the fail-closed RLS policy on this table.
      expect(
        await prisma.outboxEvent.count({ where: { tenantId: other.id, processedAt: null } }),
      ).toBe(3);
    } finally {
      await prisma.outboxEvent.deleteMany({ where: { tenantId: other.id } });
      await prisma.tenant.deleteMany({ where: { code: `${tenantCode}_2` } });
    }
  });

  it('carries the tenant into the dispatched event, so a handler is scoped', async () => {
    let received: string | undefined;
    eventBus.on('sales.invoice.posted', 'spec.metadata', (event) => {
      received = event.metadata.tenantId;
    });
    await insertEvents(1);

    await eventBus.drainTenant(tenantId);

    expect(received).toBe(tenantId);
  });
});
