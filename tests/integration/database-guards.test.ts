import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHART_OF_ACCOUNTS, findParentCode } from '../../prisma/seed/chart-of-accounts';
import { JournalEntryDraft } from '@/lib/domain/accounting/journal-entry';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { unwrap } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { calculateInvoice } from '@/lib/domain/sales/invoice-calculator';
import { allocateDocumentNumber } from '@/lib/application/services/numbering-service';
import { persistJournalEntry, reverseJournalEntry } from '@/lib/application/services/journal-service';
import { postPurchaseInvoice } from '@/lib/application/use-cases/post-purchase-invoice';
import { postSalesInvoice } from '@/lib/application/use-cases/post-sales-invoice';
import { recordPayment } from '@/lib/application/use-cases/record-payment';
import { transferStock } from '@/lib/application/services/inventory-service';
import { PermissionSet } from '@/lib/infrastructure/auth/rbac';
import type { RequestContext } from '@/lib/infrastructure/auth/request-context';
import { withTransaction } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';

/**
 * Integration tests against a real PostgreSQL instance.
 *
 * These exist because the unit tests prove what the *application* does, and half
 * the guarantees in this system are enforced by the database — triggers, check
 * constraints, partition routing, row locks. A test suite that only exercises
 * TypeScript would pass just as happily if every trigger had been dropped.
 *
 * Each run builds its own isolated tenant, so the suite is re-runnable and does
 * not depend on the seed having been run first.
 */

const prisma = new PrismaClient();

interface Fixture {
  tenantId: string;
  userId: string;
  secondUserId: string;
  branchId: string;
  warehouseId: string;
  secondWarehouseId: string;
  productId: string;
  customerId: string;
  supplierId: string;
  cashAccountId: string;
  accountsByCode: Map<string, string>;
  context: RequestContext;
  secondContext: RequestContext;
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Ledger immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('posted ledger immutability', () => {
  it('refuses to UPDATE a posted journal', async () => {
    const journal = await postSimpleJournal('immutability probe');

    await expect(
      prisma.$executeRaw`
        UPDATE "journals" SET "totalDebit" = 999 WHERE "id" = ${journal.id}::uuid
      `,
    ).rejects.toThrow(/append-only|posted and cannot be modified|ERP0/i);
  });

  it('refuses to DELETE a posted journal', async () => {
    const journal = await postSimpleJournal('delete probe');

    await expect(
      prisma.$executeRaw`DELETE FROM "journals" WHERE "id" = ${journal.id}::uuid`,
    ).rejects.toThrow(/posted and cannot be deleted|ERP0/i);
  });

  it('refuses to change the lines of a posted journal', async () => {
    const journal = await postSimpleJournal('line probe');

    await expect(
      prisma.$executeRaw`
        UPDATE "journal_lines" SET "debit" = 1 WHERE "journalId" = ${journal.id}::uuid
      `,
    ).rejects.toThrow(/posted; its lines cannot be changed|ERP0/i);
  });

  it('refuses to insert a journal that is already posted', async () => {
    // A journal must pass through DRAFT so that its lines exist and are checked
    // before the posting trigger fires.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "journals" ("id", "tenantId", "entryNumber", "type", "status", "date",
                                "descriptionAr", "createdById", "updatedAt")
        VALUES (gen_random_uuid(), ${fixture.tenantId}::uuid, 'JE-BAD-1', 'GENERAL', 'POSTED',
                '2026-03-15', 'smuggled', ${fixture.userId}::uuid, now())
      `,
    ).rejects.toThrow(/must be created in DRAFT|ERP03/i);
  });

  it('refuses an unbalanced journal at the moment of posting', async () => {
    const result = await withTransaction(async (tx) => {
      const draft = new JournalEntryDraft(journalProps('unbalanced probe'));
      draft.debit(accountId('1-1-01-001'), Money.of('100', 'SAR'));
      draft.credit(accountId('4-1-01-001'), Money.of('100', 'SAR'));

      const validated = unwrap(draft.validate());

      // Corrupt the header totals after validation, to prove the database checks
      // independently of the application.
      const tampered = {
        ...validated,
        totalDebit: Money.of('999', 'SAR'),
        totalCredit: Money.of('999', 'SAR'),
      };

      return persistJournalEntry(tx, tampered, {
        audit: auditContext(),
        createdById: fixture.userId,
      });
    }).then(
      (value) => ({ threw: false as const, value }),
      (error: unknown) => ({ threw: true as const, error }),
    );

    // Either the domain returns a refusal or the database throws — both are
    // acceptable outcomes; silently posting it is not.
    if (result.threw) {
      expect(String(result.error)).toMatch(/disagree with its lines|out of balance|ERP05/i);
    } else {
      expect(result.value.ok).toBe(false);
    }
  });

  it('refuses a single-sided journal line via a check constraint', async () => {
    const journal = await createDraftJournal('constraint probe');

    await expect(
      prisma.$executeRaw`
        INSERT INTO "journal_lines" ("id", "tenantId", "journalId", "journalDate", "lineNumber",
                                     "accountId", "debit", "credit")
        VALUES (gen_random_uuid(), ${fixture.tenantId}::uuid, ${journal.id}::uuid,
                '2026-03-15', 99, ${accountId('1-1-01-001')}::uuid, 100, 100)
      `,
    ).rejects.toThrow(/journal_lines_single_sided/i);
  });

  it('refuses to post to a summary account', async () => {
    const journal = await createDraftJournal('summary probe');

    await expect(
      prisma.$executeRaw`
        INSERT INTO "journal_lines" ("id", "tenantId", "journalId", "journalDate", "lineNumber",
                                     "accountId", "debit", "credit")
        VALUES (gen_random_uuid(), ${fixture.tenantId}::uuid, ${journal.id}::uuid,
                '2026-03-15', 98, ${accountId('1')}::uuid, 100, 0)
      `,
    ).rejects.toThrow(/summary account|ERP06/i);
  });

  it('enqueues each journal event exactly once, and re-enqueuing is rejected', async () => {
    // The regression this exists for: `persistJournalEntry` enqueues its own events before
    // returning them, and `/api/finance/journals` enqueued the returned array a second time.
    // The outbox primary key is the event id, so the second insert aborted the transaction —
    // every manual journal entry through that endpoint failed with a 500, while the seed,
    // which calls `persistJournalEntry` directly, worked. Nothing caught it because the
    // screen was only ever checked for rendering.
    const posted = await withTransaction(async (tx) => {
      const draft = new JournalEntryDraft(journalProps('outbox once'));
      draft.debit(accountId('1-1-01-001'), Money.of('40.00', 'SAR'));
      draft.credit(accountId('4-1-01-001'), Money.of('40.00', 'SAR'));

      return persistJournalEntry(tx, unwrap(draft.validate()), {
        audit: auditContext(),
        createdById: fixture.userId,
      });
    });

    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    // One row per event, already written by `persistJournalEntry`.
    expect(posted.value.events.length).toBeGreaterThan(0);
    for (const event of posted.value.events) {
      expect(await prisma.outboxEvent.count({ where: { id: event.eventId } })).toBe(1);
    }

    // And a caller that treats the returned array as work still to be done is refused rather
    // than silently double-publishing to every subscriber.
    await expect(
      withTransaction(async (tx) => {
        await eventBus.enqueue(tx, posted.value.events);
      }),
    ).rejects.toThrow();
  });

  it('keeps account balances in step with what was posted', async () => {
    const before = await accountBalance('1-1-01-001');
    await postSimpleJournal('balance movement', '250.50');
    const after = await accountBalance('1-1-01-001');

    // Cash is a debit-nature account, so a debit increases it.
    expect(after.subtract(before).toFixed(2)).toBe('250.50');
  });
});

describe('audit trail immutability', () => {
  it('refuses to UPDATE an audit row', async () => {
    await postSimpleJournal('audit probe');
    const row = await prisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId },
      select: { id: true },
    });
    expect(row).not.toBeNull();

    await expect(
      prisma.$executeRaw`UPDATE "audit_logs" SET "action" = 'LOGIN' WHERE "id" = ${row?.id ?? ''}::uuid`,
    ).rejects.toThrow(/append-only|ERP01/i);
  });

  it('refuses to DELETE an audit row', async () => {
    const row = await prisma.auditLog.findFirst({
      where: { tenantId: fixture.tenantId },
      select: { id: true },
    });

    await expect(
      prisma.$executeRaw`DELETE FROM "audit_logs" WHERE "id" = ${row?.id ?? ''}::uuid`,
    ).rejects.toThrow(/append-only|ERP01/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Sequential numbering
// ─────────────────────────────────────────────────────────────────────────────

describe('document numbering', () => {
  it('never issues the same number twice', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTransaction((tx) =>
          allocateDocumentNumber(tx, fixture.tenantId, 'SALES_INVOICE', 2026),
        ),
      ),
    );

    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('leaves a permanent gap when a draft is deleted', async () => {
    const first = await withTransaction((tx) =>
      allocateDocumentNumber(tx, fixture.tenantId, 'PAYMENT_VOUCHER', 2026),
    );
    // The document this number belonged to is discarded; the number is not reused.
    const second = await withTransaction((tx) =>
      allocateDocumentNumber(tx, fixture.tenantId, 'PAYMENT_VOUCHER', 2026),
    );

    const firstSequence = Number.parseInt(first.split('-')[2] ?? '0', 10);
    const secondSequence = Number.parseInt(second.split('-')[2] ?? '0', 10);
    expect(secondSequence).toBe(firstSequence + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory rules', () => {
  it('receives stock through a purchase and values it at net cost', async () => {
    const documentId = await createDraftDocument('PURCHASE_INVOICE', fixture.supplierId, [
      { quantity: '100', unitPrice: '50.00' },
    ]);

    const posted = await postPurchaseInvoice(fixture.context, { documentId });
    expect(posted.ok).toBe(true);

    const level = await prisma.stockLevel.findFirst({
      where: { tenantId: fixture.tenantId, productId: fixture.productId, warehouseId: fixture.warehouseId },
    });

    expect(level?.quantityOnHand.toFixed(0)).toBe('100');
    expect(level?.averageCost.toFixed(2)).toBe('50.00');
    expect(level?.totalValue.toFixed(2)).toBe('5000.00');
  });

  it('refuses a sale larger than the available balance, naming the numbers', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, [
      { quantity: '999999', unitPrice: '80.00' },
    ]);

    const posted = await postSalesInvoice(fixture.context, { documentId });

    expect(posted.ok).toBe(false);
    if (!posted.ok) {
      expect(posted.error.code).toBe('INSUFFICIENT_STOCK');
      expect(posted.error.messageAr).toContain('999999');
    }
  });

  it('posts a sale, moving stock, revenue, VAT and cost of sales together', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, [
      { quantity: '10', unitPrice: '80.00' },
    ]);

    const posted = await postSalesInvoice(fixture.context, { documentId });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    // 10 units at an average cost of 50.00
    expect(posted.value.cogsTotal).toBe('500.0000');

    const journal = await prisma.journal.findFirst({
      where: { tenantId: fixture.tenantId, referenceId: documentId },
      include: { lines: true },
    });

    expect(journal?.status).toBe('POSTED');
    expect(journal?.totalDebit.toFixed(2)).toBe(journal?.totalCredit.toFixed(2));

    // Balanced is necessary and nowhere near sufficient: a journal that debited and credited
    // the *same* account would balance perfectly and record nothing. So assert the shape of
    // the entry a sale actually makes — receivable and cost of sales on the debit side,
    // revenue, VAT and inventory on the credit side.
    const byAccount = new Map<string, { debit: string; credit: string }>();
    for (const line of journal?.lines ?? []) {
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: line.accountId },
        select: { code: true },
      });
      const current = byAccount.get(account.code) ?? { debit: '0', credit: '0' };
      byAccount.set(account.code, {
        debit: (Number(current.debit) + Number(line.debit.toFixed(2))).toFixed(2),
        credit: (Number(current.credit) + Number(line.credit.toFixed(2))).toFixed(2),
      });
    }

    const debits = [...byAccount.entries()].filter(([, side]) => Number(side.debit) > 0);
    const credits = [...byAccount.entries()].filter(([, side]) => Number(side.credit) > 0);

    // 10 x 80.00 = 800.00 net, 15% VAT = 120.00, gross 920.00; cost 10 x 50.00 = 500.00.
    expect(debits.map(([code]) => code).sort()).toHaveLength(2);
    expect(credits.map(([code]) => code).sort()).toHaveLength(3);

    const totalDebit = debits.reduce((sum, [, side]) => sum + Number(side.debit), 0);
    const totalCredit = credits.reduce((sum, [, side]) => sum + Number(side.credit), 0);
    expect(totalDebit.toFixed(2)).toBe('1420.00');
    expect(totalCredit.toFixed(2)).toBe('1420.00');

    // No account may appear on both sides of one entry — that is the netting a balanced-only
    // assertion cannot see.
    const bothSides = [...byAccount.entries()].filter(
      ([, side]) => Number(side.debit) > 0 && Number(side.credit) > 0,
    );
    expect(bothSides.map(([code]) => code)).toEqual([]);

    const level = await prisma.stockLevel.findFirst({
      where: { tenantId: fixture.tenantId, productId: fixture.productId, warehouseId: fixture.warehouseId },
    });
    expect(level?.quantityOnHand.toFixed(0)).toBe('90');
  });

  it('generates a ZATCA e-invoice chained to the previous one', async () => {
    const invoices = await prisma.zatcaInvoice.findMany({
      where: { document: { tenantId: fixture.tenantId } },
      orderBy: { issuedAtUtc: 'asc' },
    });

    expect(invoices.length).toBeGreaterThan(0);
    for (const invoice of invoices) {
      expect(invoice.invoiceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(invoice.previousHash).toMatch(/^[0-9a-f]{64}$/);
      expect(invoice.qrCode.length).toBeGreaterThan(0);
    }
  });

  it('refuses a transfer to the same warehouse', async () => {
    const result = await withTransaction((tx) =>
      transferStock(tx, {
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        productId: fixture.productId,
        date: unwrap(DateOnly.create('2026-03-20')),
        createdById: fixture.userId,
        fromWarehouseId: fixture.warehouseId,
        toWarehouseId: fixture.warehouseId,
        quantity: Quantity.of('1'),
        costingMethod: 'WEIGHTED_AVERAGE',
        allowNegativeStock: false,
        currency: 'SAR',
        productNameAr: 'صنف',
        productNameEn: 'Item',
        fromWarehouseNameAr: 'مستودع',
        fromWarehouseNameEn: 'Warehouse',
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SAME_WAREHOUSE_TRANSFER');
  });

  it('moves value between warehouses without creating or destroying any', async () => {
    const before = await totalInventoryValue();

    const result = await withTransaction((tx) =>
      transferStock(tx, {
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        productId: fixture.productId,
        date: unwrap(DateOnly.create('2026-03-20')),
        createdById: fixture.userId,
        fromWarehouseId: fixture.warehouseId,
        toWarehouseId: fixture.secondWarehouseId,
        quantity: Quantity.of('20'),
        costingMethod: 'WEIGHTED_AVERAGE',
        allowNegativeStock: false,
        currency: 'SAR',
        productNameAr: 'صنف',
        productNameEn: 'Item',
        fromWarehouseNameAr: 'مستودع',
        fromWarehouseNameEn: 'Warehouse',
      }),
    );

    expect(result.ok).toBe(true);
    const after = await totalInventoryValue();
    expect(after.toFixed(2)).toBe(before.toFixed(2));

    if (result.ok) {
      const movements = await prisma.inventoryMovement.findMany({
        where: { transferGroupId: result.value.transferGroupId },
      });
      expect(movements).toHaveLength(2);
    }
  });

  it('refuses to drive a stock level negative even by raw SQL', async () => {
    await expect(
      prisma.$executeRaw`
        UPDATE "stock_levels" SET "quantityOnHand" = -1
         WHERE "tenantId" = ${fixture.tenantId}::uuid
           AND "productId" = ${fixture.productId}::uuid
           AND "warehouseId" = ${fixture.warehouseId}::uuid
      `,
    ).rejects.toThrow(/negative stock is not permitted|ERP09/i);
  });

  it('refuses to modify a recorded movement', async () => {
    const movement = await prisma.inventoryMovement.findFirst({
      where: { tenantId: fixture.tenantId },
      select: { id: true },
    });

    await expect(
      prisma.$executeRaw`
        UPDATE "inventory_movements" SET "quantity" = 1 WHERE "id" = ${movement?.id ?? ''}::uuid
      `,
    ).rejects.toThrow(/append-only|ERP01/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Documents and settlement
// ─────────────────────────────────────────────────────────────────────────────

describe('document lifecycle', () => {
  it('refuses to post the same invoice twice', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, [
      { quantity: '5', unitPrice: '80.00' },
    ]);

    expect((await postSalesInvoice(fixture.context, { documentId })).ok).toBe(true);

    const second = await postSalesInvoice(fixture.context, { documentId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DOCUMENT_ALREADY_POSTED');
  });

  it('refuses to edit a posted document', async () => {
    const document = await prisma.document.findFirst({
      where: { tenantId: fixture.tenantId, isPosted: true },
      select: { id: true },
    });

    await expect(
      prisma.$executeRaw`
        UPDATE "documents" SET "total" = 1 WHERE "id" = ${document?.id ?? ''}::uuid
      `,
    ).rejects.toThrow(/posted and cannot be modified|ERP08/i);
  });

  it('refuses an empty invoice', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, []);
    const posted = await postSalesInvoice(fixture.context, { documentId });

    expect(posted.ok).toBe(false);
    if (!posted.ok) expect(posted.error.code).toBe('EMPTY_DOCUMENT');
  });

  it('settles partially, then fully, updating status from the arithmetic', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, [
      { quantity: '4', unitPrice: '100.00' },
    ]);
    await postSalesInvoice(fixture.context, { documentId });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const total = Money.of(document.total.toFixed(4), 'SAR');
    const half = total.divide('2').round(2);

    const partial = await recordPayment(fixture.secondContext, {
      type: 'RECEIPT',
      counterpartyId: fixture.customerId,
      branchId: fixture.branchId,
      paymentDate: '2026-04-01',
      amount: half.toFixed(2),
      currency: 'SAR',
      method: 'BANK',
      accountId: fixture.cashAccountId,
      allocations: [{ documentId, amount: half.toFixed(2) }],
    });

    expect(partial.ok).toBe(true);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe(
      'PARTIAL_PAID',
    );

    const remainder = total.subtract(half);
    const settlement = await recordPayment(fixture.secondContext, {
      type: 'RECEIPT',
      counterpartyId: fixture.customerId,
      branchId: fixture.branchId,
      paymentDate: '2026-04-15',
      amount: remainder.toFixed(2),
      currency: 'SAR',
      method: 'CASH',
      accountId: fixture.cashAccountId,
      allocations: [{ documentId, amount: remainder.toFixed(2) }],
    });

    expect(settlement.ok).toBe(true);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe(
      'FULLY_PAID',
    );
  });

  it('refuses to collect more than the invoice owes', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, [
      { quantity: '2', unitPrice: '100.00' },
    ]);
    await postSalesInvoice(fixture.context, { documentId });

    const result = await recordPayment(fixture.secondContext, {
      type: 'RECEIPT',
      counterpartyId: fixture.customerId,
      branchId: fixture.branchId,
      paymentDate: '2026-04-01',
      amount: '99999.00',
      currency: 'SAR',
      method: 'CASH',
      accountId: fixture.cashAccountId,
      allocations: [{ documentId, amount: '99999.00' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OVERPAYMENT_NOT_ALLOWED');
  });

  it('refuses to settle a draft document', async () => {
    const documentId = await createDraftDocument('SALES_INVOICE', fixture.customerId, [
      { quantity: '1', unitPrice: '100.00' },
    ]);

    const result = await recordPayment(fixture.secondContext, {
      type: 'RECEIPT',
      counterpartyId: fixture.customerId,
      branchId: fixture.branchId,
      paymentDate: '2026-04-01',
      amount: '10.00',
      currency: 'SAR',
      method: 'CASH',
      accountId: fixture.cashAccountId,
      allocations: [{ documentId, amount: '10.00' }],
    });

    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Segregation of duties, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('segregation of duties, enforced through the real use case', () => {
  it('stops the creator from posting their own invoice when enforcement is on', async () => {
    await prisma.tenant.update({
      where: { id: fixture.tenantId },
      data: { enforceSoD: true },
    });

    try {
      const documentId = await createDraftDocument(
        'SALES_INVOICE',
        fixture.customerId,
        [{ quantity: '1', unitPrice: '100.00' }],
        fixture.secondUserId,
      );

      // The second user created it, so the second user may not post it.
      const refused = await postSalesInvoice(fixture.secondContext, { documentId });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('SOD_VIOLATION');

      // A different user can.
      const accepted = await postSalesInvoice(
        { ...fixture.context, isSuperAdmin: false },
        { documentId },
      );
      expect(accepted.ok).toBe(true);
    } finally {
      await prisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { enforceSoD: false },
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Reversal
// ─────────────────────────────────────────────────────────────────────────────

describe('journal reversal', () => {
  it('reverses by generating a mirror entry rather than editing history', async () => {
    const journal = await postSimpleJournal('to be reversed', '400.00');

    const result = await withTransaction((tx) =>
      reverseJournalEntry(
        tx,
        fixture.tenantId,
        journal.id,
        journal.date,
        unwrap(DateOnly.create('2026-05-01')),
        {
          audit: auditContext(),
          createdById: fixture.userId,
          reasonAr: 'تصحيح خطأ',
        },
      ),
    );

    expect(result.ok).toBe(true);

    const original = await prisma.journal.findUniqueOrThrow({
      where: { id_date: { id: journal.id, date: journal.date } },
    });
    expect(original.status).toBe('REVERSED');
    expect(original.isReversed).toBe(true);

    if (result.ok) {
      const reversal = await prisma.journal.findFirstOrThrow({
        where: { id: result.value.journalId },
        include: { lines: true },
      });
      expect(reversal.totalDebit.toFixed(2)).toBe(original.totalDebit.toFixed(2));
      expect(reversal.lines.length).toBe(2);
    }
  });

  it('refuses to reverse the same entry twice', async () => {
    const journal = await postSimpleJournal('double reversal', '100.00');

    const first = await withTransaction((tx) =>
      reverseJournalEntry(tx, fixture.tenantId, journal.id, journal.date, unwrap(DateOnly.create('2026-05-01')), {
        audit: auditContext(),
        createdById: fixture.userId,
        reasonAr: 'تصحيح',
      }),
    );
    expect(first.ok).toBe(true);

    const second = await withTransaction((tx) =>
      reverseJournalEntry(tx, fixture.tenantId, journal.id, journal.date, unwrap(DateOnly.create('2026-05-02')), {
        audit: auditContext(),
        createdById: fixture.userId,
        reasonAr: 'تصحيح',
      }),
    ).catch(() => ({ ok: false as const }));

    expect(second.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function accountId(code: string): string {
  const id = fixture.accountsByCode.get(code);
  if (id === undefined) throw new Error(`Account ${code} is missing from the fixture.`);
  return id;
}

function auditContext() {
  return {
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    ipAddress: '127.0.0.1',
    userAgent: 'integration-test',
    sessionId: 'test',
    correlationId: crypto.randomUUID(),
  };
}

function journalProps(description: string) {
  return {
    tenantId: fixture.tenantId,
    type: 'GENERAL' as const,
    date: unwrap(DateOnly.create('2026-03-15')),
    descriptionAr: description,
    branchId: fixture.branchId,
    currency: 'SAR',
    exchangeRate: '1',
    functionalCurrency: 'SAR',
  };
}

async function postSimpleJournal(
  description: string,
  amount = '100.00',
): Promise<{ id: string; date: Date }> {
  const result = await withTransaction(async (tx) => {
    const draft = new JournalEntryDraft(journalProps(description));
    draft.debit(accountId('1-1-01-001'), Money.of(amount, 'SAR'));
    draft.credit(accountId('4-1-01-001'), Money.of(amount, 'SAR'));

    return persistJournalEntry(tx, unwrap(draft.validate()), {
      audit: auditContext(),
      createdById: fixture.userId,
    });
  });

  if (!result.ok) throw new Error(result.error.messageEn);
  return { id: result.value.journalId, date: result.value.date };
}

/** A journal left in DRAFT, for probing the constraints that guard its lines. */
async function createDraftJournal(description: string): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const entryNumber = await allocateDocumentNumber(tx, fixture.tenantId, 'JOURNAL', 2026);
    return tx.journal.create({
      data: {
        tenantId: fixture.tenantId,
        entryNumber,
        type: 'GENERAL',
        status: 'DRAFT',
        date: new Date('2026-03-15T00:00:00Z'),
        descriptionAr: description,
        currency: 'SAR',
        exchangeRate: '1',
        createdById: fixture.userId,
      },
      select: { id: true },
    });
  });
}

async function createDraftDocument(
  type: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
  counterpartyId: string,
  lines: readonly { quantity: string; unitPrice: string }[],
  createdById = fixture.userId,
): Promise<string> {
  const calculated =
    lines.length === 0
      ? null
      : unwrap(
          calculateInvoice(
            lines.map(({ quantity, unitPrice }) => ({
              productId: fixture.productId,
              quantity: Quantity.of(quantity),
              unitPrice: Money.of(unitPrice, 'SAR'),
              taxRate: '15.00',
            })),
            { currency: 'SAR', mergeDuplicates: false },
          ),
        );

  return withTransaction(async (tx) => {
    const documentNumber = await allocateDocumentNumber(
      tx,
      fixture.tenantId,
      type === 'SALES_INVOICE' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE',
      2026,
    );

    const document = await tx.document.create({
      data: {
        tenantId: fixture.tenantId,
        documentNumber,
        type,
        status: 'DRAFT',
        counterpartyId,
        branchId: fixture.branchId,
        warehouseId: fixture.warehouseId,
        issueDate: new Date('2026-03-15T00:00:00Z'),
        dueDate: new Date('2026-04-15T00:00:00Z'),
        currency: 'SAR',
        exchangeRate: '1',
        subtotal: calculated?.subtotal.toString() ?? '0',
        discountTotal: calculated?.discountTotal.toString() ?? '0',
        taxTotal: calculated?.taxTotal.toString() ?? '0',
        total: calculated?.total.toString() ?? '0',
        createdById,
      },
      select: { id: true },
    });

    if (calculated !== null) {
      await tx.documentLine.createMany({
        data: calculated.lines.map((line) => ({
          tenantId: fixture.tenantId,
          documentId: document.id,
          lineNumber: line.lineNumber,
          productId: line.productId,
          quantity: line.quantity.toString(),
          unitPrice: line.unitPrice.toString(),
          discount: line.discount.toString(),
          taxRate: line.taxRate,
          taxAmount: line.taxAmount.toString(),
          lineTotal: line.lineTotal.toString(),
        })),
      });
    }

    return document.id;
  });
}

async function accountBalance(code: string): Promise<Money> {
  const account = await prisma.account.findFirstOrThrow({
    where: { tenantId: fixture.tenantId, code },
    select: { balance: true },
  });
  return Money.of(account.balance.toFixed(4), 'SAR');
}

async function totalInventoryValue(): Promise<Money> {
  const rows = await prisma.stockLevel.findMany({
    where: { tenantId: fixture.tenantId },
    select: { totalValue: true },
  });
  return rows.reduce(
    (total, row) => total.add(Money.of(row.totalValue.toFixed(4), 'SAR')),
    Money.zero('SAR'),
  );
}

/**
 * Builds an isolated tenant with the minimum needed to exercise every rule:
 * a full chart of accounts and mappings, two users, one branch, two warehouses,
 * one product, one customer and one supplier.
 */
async function buildFixture(): Promise<Fixture> {
  const suffix = Date.now().toString(36).toUpperCase().slice(-8);

  const tenant = await prisma.tenant.create({
    data: {
      code: `TEST-${suffix}`,
      nameAr: 'منشأة اختبار',
      nameEn: 'Test Tenant',
      functionalCurrency: 'SAR',
      vatNumber: '300000000000003',
      enforceSoD: false,
      allowNegativeStock: false,
      allowOverpayment: false,
    },
    select: { id: true },
  });

  const allCodes = new Set(CHART_OF_ACCOUNTS.map((account) => account.code));
  const accountsByCode = new Map<string, string>();

  const ordered = [...CHART_OF_ACCOUNTS].sort(
    (a, b) => a.code.split('-').length - b.code.split('-').length || a.code.localeCompare(b.code),
  );

  for (const template of ordered) {
    const parentCode = findParentCode(template.code, allCodes);
    const created = await prisma.account.create({
      data: {
        tenantId: tenant.id,
        code: template.code,
        nameAr: template.nameAr,
        nameEn: template.nameEn,
        type: template.type,
        nature: template.nature,
        parentId: parentCode === null ? null : (accountsByCode.get(parentCode) ?? null),
        level: template.code.split('-').length - 1,
        path: template.code.replace(/-/g, '.'),
        isPostable: template.isPostable,
        isControl: template.isControl ?? false,
        isContra: template.isContra ?? false,
      },
      select: { id: true },
    });
    accountsByCode.set(template.code, created.id);
  }

  await prisma.accountMapping.createMany({
    data: CHART_OF_ACCOUNTS.filter((account) => account.mappingKey !== undefined).map((account) => ({
      tenantId: tenant.id,
      key: account.mappingKey as string,
      accountId: accountsByCode.get(account.code) as string,
    })),
  });

  const fiscalYear = await prisma.fiscalYear.create({
    data: {
      tenantId: tenant.id,
      year: 2026,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: new Date('2026-12-31T00:00:00Z'),
    },
    select: { id: true },
  });

  await prisma.fiscalPeriod.createMany({
    data: Array.from({ length: 12 }, (_, index) => ({
      tenantId: tenant.id,
      fiscalYearId: fiscalYear.id,
      periodNumber: index + 1,
      startDate: new Date(Date.UTC(2026, index, 1)),
      endDate: new Date(Date.UTC(2026, index + 1, 0)),
    })),
  });

  const [user, secondUser] = await Promise.all([
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: 'tester',
        email: `tester@${suffix}.test`,
        passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
        fullNameAr: 'مستخدم اختبار',
        fullNameEn: 'Test User',
        isSuperAdmin: true,
      },
      select: { id: true },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        username: 'tester2',
        email: `tester2@${suffix}.test`,
        passwordHash: '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
        fullNameAr: 'مستخدم ثانٍ',
        fullNameEn: 'Second User',
      },
      select: { id: true },
    }),
  ]);

  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, code: 'BR01', nameAr: 'الفرع', nameEn: 'Branch' },
    select: { id: true },
  });

  const [warehouse, secondWarehouse] = await Promise.all([
    prisma.warehouse.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        code: 'WH01',
        nameAr: 'المستودع الرئيسي',
        nameEn: 'Main Warehouse',
      },
      select: { id: true },
    }),
    prisma.warehouse.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        code: 'WH02',
        nameAr: 'المستودع الثاني',
        nameEn: 'Second Warehouse',
      },
      select: { id: true },
    }),
  ]);

  const category = await prisma.category.create({
    data: { tenantId: tenant.id, code: 'GEN', nameAr: 'عام', nameEn: 'General' },
    select: { id: true },
  });

  const unit = await prisma.unitOfMeasure.create({
    data: { tenantId: tenant.id, code: 'PCS', nameAr: 'قطعة', nameEn: 'Piece' },
    select: { id: true },
  });

  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      sku: 'TST-1001',
      nameAr: 'صنف اختبار',
      nameEn: 'Test Product',
      categoryId: category.id,
      unitOfMeasureId: unit.id,
      salePrice: '80.0000',
      costPrice: '50.0000',
      taxRate: '15.00',
    },
    select: { id: true },
  });

  const [customer, supplier] = await Promise.all([
    prisma.counterparty.create({
      data: {
        tenantId: tenant.id,
        code: 'CUS-0001',
        type: 'CUSTOMER',
        nameAr: 'عميل اختبار',
        nameEn: 'Test Customer',
        taxNumber: '300000000000003',
        // Left at zero so the credit-limit rule does not fire during these tests.
        creditLimit: '0',
      },
      select: { id: true },
    }),
    prisma.counterparty.create({
      data: {
        tenantId: tenant.id,
        code: 'SUP-0001',
        type: 'SUPPLIER',
        nameAr: 'مورد اختبار',
        nameEn: 'Test Supplier',
      },
      select: { id: true },
    }),
  ]);

  const baseContext = {
    tenantId: tenant.id,
    branchId: branch.id,
    permissions: new PermissionSet([], true),
    isSuperAdmin: true,
    sessionId: 'test',
    ipAddress: '127.0.0.1',
    userAgent: 'integration-test',
    locale: 'ar' as const,
  };

  return {
    tenantId: tenant.id,
    userId: user.id,
    secondUserId: secondUser.id,
    branchId: branch.id,
    warehouseId: warehouse.id,
    secondWarehouseId: secondWarehouse.id,
    productId: product.id,
    customerId: customer.id,
    supplierId: supplier.id,
    cashAccountId: accountsByCode.get('1-1-01-001') as string,
    accountsByCode,
    context: {
      ...baseContext,
      userId: user.id,
      username: 'tester',
      correlationId: crypto.randomUUID(),
    },
    secondContext: {
      ...baseContext,
      userId: secondUser.id,
      username: 'tester2',
      isSuperAdmin: false,
      permissions: new PermissionSet(['*:*']),
      correlationId: crypto.randomUUID(),
    },
  };
}
