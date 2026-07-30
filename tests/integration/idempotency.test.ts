import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { lookupOutcome, recordOutcome, sweepIdempotencyRecords } from '@/lib/api/idempotency';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * Idempotent replay.
 *
 * The property under test is the one that makes the offline queue safe rather than
 * dangerous: a submission sent twice must happen once. Everything here is about the
 * cases where a naive implementation returns the *wrong* answer rather than merely a
 * duplicate one, because those are the failures that would be discovered from a
 * customer's accounts rather than from a log.
 *
 * Against a real database because the decisive part is a unique index. Two replays
 * arriving together both find nothing on their lookup; what stops them both proceeding
 * is PostgreSQL, and no fake reproduces that.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

const tenantCode = 'IDEM_SPEC';
let tenantId = '';
let userId = '';

async function cleanup(): Promise<void> {
  const tenant = await prisma.tenant.findFirst({
    where: { code: tenantCode },
    select: { id: true },
  });
  if (tenant === null) return;

  await prisma.requestIdempotency.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
}

/** Records an outcome the way the handler does — inside a tenant scope. */
function record(input: {
  key: string;
  endpoint: string;
  body: unknown;
  httpStatus: number;
  responseBody: unknown;
}): Promise<void> {
  return runInTenantScope({ tenantId }, () =>
    recordOutcome({ tenantId, userId, ...input }),
  );
}

function lookup(input: { key: string; endpoint: string; body: unknown }) {
  return runInTenantScope({ tenantId }, () => lookupOutcome({ tenantId, ...input }));
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('request idempotency', () => {
  beforeEach(async () => {
    await cleanup();
    const tenant = await prisma.tenant.create({
      data: { code: tenantCode, nameAr: 'تكرار', nameEn: 'Idempotency' },
      select: { id: true },
    });
    tenantId = tenant.id;
    userId = randomUUID();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('has nothing to replay for a key never seen', async () => {
    const found = await lookup({ key: 'fresh', endpoint: '/api/sales/invoices', body: { a: 1 } });

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBeNull();
  });

  it('returns the recorded outcome verbatim, status included', async () => {
    const body = { counterpartyId: 'c-1', lines: [{ productId: 'p-1' }] };
    const response = { success: true, data: { documentNumber: 'INV-2026-00042' } };
    await record({ key: 'k1', endpoint: '/api/sales/invoices', body, httpStatus: 200, responseBody: response });

    const found = await lookup({ key: 'k1', endpoint: '/api/sales/invoices', body });

    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    // The replay must be indistinguishable from the original, or the client acts on the
    // difference — and the number it needs is in here.
    expect(found.value.httpStatus).toBe(200);
    expect(found.value.responseBody).toEqual(response);
  });

  it('replays a refusal too, so a rejected submission is not re-run', async () => {
    // The work already happened once and was declined. Re-running the handler could
    // succeed the second time — against a period that has since opened, say — turning a
    // retry into an action the user never took twice.
    const body = { a: 1 };
    const response = { success: false, error: { code: 'PERIOD_CLOSED' } };
    await record({ key: 'k2', endpoint: '/api/finance/journals', body, httpStatus: 422, responseBody: response });

    const found = await lookup({ key: 'k2', endpoint: '/api/finance/journals', body });

    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    expect(found.value.httpStatus).toBe(422);
  });

  it('refuses a key first used on a different endpoint', async () => {
    await record({ key: 'k3', endpoint: '/api/sales/invoices', body: { a: 1 }, httpStatus: 200, responseBody: {} });

    // Answering a journal POST with a stored invoice response would be worse than
    // failing: the client would take an invoice number as a journal number.
    const found = await lookup({ key: 'k3', endpoint: '/api/finance/journals', body: { a: 1 } });

    expect(found.ok).toBe(false);
  });

  it('refuses a key reused with a different body', async () => {
    await record({ key: 'k4', endpoint: '/api/sales/invoices', body: { total: '100' }, httpStatus: 200, responseBody: {} });

    // This is the case that would silently return the first document's number for the
    // second document's data — the quietest possible way to lose an invoice.
    const found = await lookup({ key: 'k4', endpoint: '/api/sales/invoices', body: { total: '999' } });

    expect(found.ok).toBe(false);
  });

  it('keeps keys separate across tenants', async () => {
    const other = await prisma.tenant.create({
      data: { code: `${tenantCode}_2`, nameAr: 'آخر', nameEn: 'Other' },
      select: { id: true },
    });

    try {
      await record({ key: 'shared', endpoint: '/api/sales/invoices', body: { a: 1 }, httpStatus: 200, responseBody: { n: 1 } });

      // Two tenants generating the same uuid is not a collision worth coupling them over.
      const found = await runInTenantScope({ tenantId: other.id }, () =>
        lookupOutcome({
          tenantId: other.id,
          key: 'shared',
          endpoint: '/api/sales/invoices',
          body: { a: 1 },
        }),
      );

      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value).toBeNull();
    } finally {
      await prisma.requestIdempotency.deleteMany({ where: { tenantId: other.id } });
      await prisma.tenant.delete({ where: { id: other.id } });
    }
  });

  it('treats a concurrent duplicate record as success, not as an error', async () => {
    // Two replays racing: both looked up, both found nothing, both are now writing. The
    // loser must not surface an error — the outcome it was trying to store is already
    // stored, which is exactly what it wanted.
    const body = { a: 1 };

    const outcomes = await Promise.allSettled([
      record({ key: 'race', endpoint: '/api/sales/invoices', body, httpStatus: 200, responseBody: { n: 1 } }),
      record({ key: 'race', endpoint: '/api/sales/invoices', body, httpStatus: 200, responseBody: { n: 1 } }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(
      await prisma.requestIdempotency.count({ where: { tenantId, key: 'race' } }),
    ).toBe(1);
  });

  it('is the unique index that enforces one record per key', async () => {
    await record({ key: 'once', endpoint: '/api/sales/invoices', body: { a: 1 }, httpStatus: 200, responseBody: {} });

    // Written directly, bypassing `recordOutcome`'s handling, to show the constraint is
    // real rather than a convention the application maintains.
    await expect(
      prisma.requestIdempotency.create({
        data: {
          tenantId,
          userId,
          key: 'once',
          endpoint: '/api/sales/invoices',
          requestHash: 'x'.repeat(64),
          httpStatus: 200,
          responseBody: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('sweeps records past the retry window and keeps the rest', async () => {
    await record({ key: 'old', endpoint: '/api/sales/invoices', body: { a: 1 }, httpStatus: 200, responseBody: {} });
    await record({ key: 'new', endpoint: '/api/sales/invoices', body: { a: 2 }, httpStatus: 200, responseBody: {} });

    await prisma.$executeRaw`
      UPDATE "request_idempotency" SET "createdAt" = now() - interval '3 days' WHERE "key" = 'old'
    `;

    const deleted = await sweepIdempotencyRecords(86_400);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.requestIdempotency.count({ where: { tenantId, key: 'old' } })).toBe(0);
    expect(await prisma.requestIdempotency.count({ where: { tenantId, key: 'new' } })).toBe(1);
  });

  it('is covered by a tenant isolation policy, like every table carrying a tenantId', async () => {
    const policies = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'request_idempotency'
    `;

    expect(Number(policies[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});
