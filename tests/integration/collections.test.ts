import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getCollectionsOverview,
  getCreditFacts,
  getStatementOfAccount,
  upsertCreditProfile,
} from '@/lib/application/services/collections-service';
import { createApprovalRule } from '@/lib/application/services/approval-rules-service';
import {
  createTradeDocument,
  setTradeDocumentStatus,
} from '@/lib/application/services/trade-document-service';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';
import { withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * Collections, credit facts, and the credit hold — against a real database.
 *
 * ## The drift guard
 *
 * "Overdue" is defined twice: once in SQL for the dashboard (a report over every customer must
 * not ship every invoice to Node) and once in `domain/collections/aging.ts` for the credit-hold
 * path (that answer gates a sale and must be exact line by line). The first test below runs
 * both over the same data and asserts they agree bucket for bucket. A dashboard that says a
 * customer is 70 days late while the gate lets their order through is worse than no dashboard.
 *
 * ## The integration that was asked for
 *
 * The last block is the point of the feature: a sales rep raising an order for a customer more
 * than 60 days overdue has it held automatically, and only the named role can release it.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let clerkId = '';
let cfoRoleId = '';
let branchId = '';
let customerId = '';
let productId = '';
const ASOF = new Date('2026-06-30T00:00:00.000Z');

function audit() {
  return {
    tenantId,
    userId: clerkId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: randomUUID(),
  };
}

let invoiceSequence = 0;

/** A posted sales invoice with an explicit due date and an outstanding balance. */
async function invoice(input: {
  dueDate: string;
  total: string;
  paid?: string;
  type?: 'SALES_INVOICE' | 'SALES_CREDIT_NOTE';
}): Promise<void> {
  invoiceSequence += 1;
  await prisma.document.create({
    data: {
      tenantId,
      documentNumber: `INV-${String(invoiceSequence).padStart(5, '0')}`,
      type: input.type ?? 'SALES_INVOICE',
      status: 'POSTED',
      counterpartyId: customerId,
      branchId,
      issueDate: new Date(`${input.dueDate}T00:00:00.000Z`),
      dueDate: new Date(`${input.dueDate}T00:00:00.000Z`),
      subtotal: input.total,
      taxTotal: '0',
      total: input.total,
      paidAmount: input.paid ?? '0',
      createdById: clerkId,
    },
  });
}

let cashAccountId = '';
let receiptSequence = 0;

/**
 * A posted receipt.
 *
 * The statement builds its credit column from `payments` rows while the ageing sums
 * `documents.paidAmount`. The application keeps those consistent — `recordPayment` writes both
 * — so a fixture that touches only one produces a state the system cannot reach, and a test
 * built on it would be measuring the fixture rather than the code.
 */
async function receipt(amount: string, date: string): Promise<void> {
  receiptSequence += 1;
  await prisma.payment.create({
    data: {
      tenantId,
      voucherNumber: `RV-${String(receiptSequence).padStart(5, '0')}`,
      type: 'RECEIPT',
      status: 'POSTED',
      counterpartyId: customerId,
      branchId,
      paymentDate: new Date(`${date}T00:00:00.000Z`),
      amount,
      method: 'CASH',
      accountId: cashAccountId,
      createdById: clerkId,
    },
  });
}

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('collections', () => {
  beforeEach(async () => {
    invoiceSequence = 0;
    receiptSequence = 0;
    const code = `COL_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'تحصيل', nameEn: 'Collections' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const cfo = await prisma.role.create({
      data: { tenantId, name: 'CFO', nameAr: 'المدير المالي' },
      select: { id: true },
    });
    cfoRoleId = cfo.id;

    const clerk = await prisma.user.create({
      data: {
        tenantId,
        username: 'rep',
        email: `rep@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'مندوب',
        fullNameEn: 'Rep',
      },
      select: { id: true },
    });
    clerkId = clerk.id;

    await prisma.user.create({
      data: {
        tenantId,
        username: 'cfo',
        email: `cfo@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'المدير المالي',
        fullNameEn: 'CFO',
        userRoles: { create: [{ roleId: cfoRoleId }] },
      },
    });

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const [category, uom] = await Promise.all([
      prisma.category.create({
        data: { tenantId, code: 'C1', nameAr: 'تصنيف', nameEn: 'Category' },
        select: { id: true },
      }),
      prisma.unitOfMeasure.create({
        data: { tenantId, code: 'EA', nameAr: 'حبة', nameEn: 'Each' },
        select: { id: true },
      }),
    ]);

    const product = await prisma.product.create({
      data: {
        tenantId,
        sku: 'SKU-1',
        nameAr: 'صنف',
        nameEn: 'Product',
        categoryId: category.id,
        unitOfMeasureId: uom.id,
        salePrice: '100.0000',
        costPrice: '60.0000',
      },
      select: { id: true },
    });
    productId = product.id;

    const customer = await prisma.counterparty.create({
      data: {
        tenantId,
        code: 'CU1',
        type: 'CUSTOMER',
        nameAr: 'عميل متعثر',
        nameEn: 'Late Customer',
        creditLimit: '100000',
      },
      select: { id: true },
    });
    customerId = customer.id;

    const cash = await prisma.account.create({
      data: {
        tenantId,
        code: '1-1-01-001',
        nameAr: 'الصندوق',
        nameEn: 'Cash',
        type: 'ASSET',
        nature: 'DEBIT',
        level: 4,
        path: '1.1.01.001',
        isPostable: true,
      },
      select: { id: true },
    });
    cashAccountId = cash.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the SQL and the domain module agree', () => {
    it('buckets identically over the same invoices', async () => {
      // One invoice per bucket, plus one not yet due.
      await invoice({ dueDate: '2026-07-15', total: '1000' }); // current
      await invoice({ dueDate: '2026-06-15', total: '2000' }); // 15 days
      await invoice({ dueDate: '2026-05-15', total: '3000' }); // 46 days
      await invoice({ dueDate: '2026-04-15', total: '4000' }); // 76 days
      await invoice({ dueDate: '2026-01-15', total: '5000' }); // 166 days

      const overview = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF }),
      );

      const row = overview.customers.find((c) => c.counterpartyId === customerId);
      expect(row).toBeDefined();
      if (row === undefined) return;

      const credit = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) => getCreditFacts(tx, { tenantId, counterpartyId: customerId, asOf: ASOF })),
      );

      // Bucket for bucket. This is the assertion that fails if either implementation of
      // "overdue" is changed without the other.
      expect(Number(row.current)).toBe(Number(credit.profile.current) / 10_000);
      expect(Number(row.days1to30)).toBe(Number(credit.profile.days1to30) / 10_000);
      expect(Number(row.days31to60)).toBe(Number(credit.profile.days31to60) / 10_000);
      expect(Number(row.days61to90)).toBe(Number(credit.profile.days61to90) / 10_000);
      expect(Number(row.over90)).toBe(Number(credit.profile.over90) / 10_000);
      expect(row.oldestOverdueDays).toBe(credit.profile.oldestOverdueDays);
    });

    it('agrees after a grace period is applied', async () => {
      // 46 days raw, 16 after 30 days' grace — which moves it a whole bucket. Both sides must
      // move it the same way.
      await invoice({ dueDate: '2026-05-15', total: '3000' });

      await runInTenantScope({ tenantId }, () =>
        upsertCreditProfile({
          tenantId,
          audit: audit(),
          counterpartyId: customerId,
          graceDays: 30,
          holdAfterDays: 60,
          isBlocked: false,
        }),
      );

      const overview = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF }),
      );
      const row = overview.customers.find((c) => c.counterpartyId === customerId);

      const credit = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) => getCreditFacts(tx, { tenantId, counterpartyId: customerId, asOf: ASOF })),
      );

      expect(row?.oldestOverdueDays).toBe(16);
      expect(credit.profile.oldestOverdueDays).toBe(16);
      expect(Number(row?.days1to30)).toBe(3000);
      expect(Number(credit.profile.days1to30) / 10_000).toBe(3000);
    });
  });

  describe('the overview', () => {
    it('nets a credit note off the balance', async () => {
      await invoice({ dueDate: '2026-05-15', total: '3000' });
      await invoice({ dueDate: '2026-05-15', total: '1000', type: 'SALES_CREDIT_NOTE' });

      const overview = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF }),
      );

      expect(Number(overview.totals.total)).toBe(2000);
    });

    it('excludes a fully paid invoice', async () => {
      await invoice({ dueDate: '2026-01-15', total: '5000', paid: '5000' });

      const overview = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF }),
      );

      expect(overview.customers.find((c) => c.counterpartyId === customerId)).toBeUndefined();
    });

    it('counts only the unpaid remainder of a part-paid invoice', async () => {
      await invoice({ dueDate: '2026-01-15', total: '5000', paid: '3000' });

      const overview = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF }),
      );

      expect(Number(overview.totals.over90)).toBe(2000);
    });

    it('reports exposure against the credit limit, uncapped', async () => {
      await invoice({ dueDate: '2026-01-15', total: '300000' });

      const overview = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF }),
      );
      const row = overview.customers.find((c) => c.counterpartyId === customerId);

      // 300,000 against a 100,000 limit.
      expect(Number(row?.exposurePercent)).toBe(300);
    });

    it('keeps the totals over the whole book when the list is filtered', async () => {
      await invoice({ dueDate: '2026-07-15', total: '1000' }); // not yet due
      await invoice({ dueDate: '2026-01-15', total: '5000' }); // very late

      const filtered = await runInTenantScope({ tenantId }, () =>
        getCollectionsOverview({ tenantId, asOf: ASOF, overdueOnly: true }),
      );

      // A total that moved when somebody ticked a filter would be a different number under
      // the same label.
      expect(Number(filtered.totals.total)).toBe(6000);
      expect(Number(filtered.totals.current)).toBe(1000);
    });
  });

  describe('credit facts', () => {
    it('reports the oldest overdue age and the overdue amount', async () => {
      await invoice({ dueDate: '2026-06-15', total: '2000' });
      await invoice({ dueDate: '2026-01-15', total: '5000' });

      const credit = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) => getCreditFacts(tx, { tenantId, counterpartyId: customerId, asOf: ASOF })),
      );

      expect(credit.facts.OVERDUE_DAYS).toBe('166');
      expect(Number(credit.facts.OVERDUE_AMOUNT)).toBe(7000);
    });

    it('treats a blocked customer as at the hold threshold whatever they owe', async () => {
      // The manual override doing its job: a customer in dispute is stopped even with a clean
      // ledger.
      await runInTenantScope({ tenantId }, () =>
        upsertCreditProfile({
          tenantId,
          audit: audit(),
          counterpartyId: customerId,
          graceDays: 0,
          holdAfterDays: 60,
          isBlocked: true,
          blockReason: 'نزاع تجاري',
        }),
      );

      const credit = await runInTenantScope({ tenantId }, () =>
        withTransaction((tx) => getCreditFacts(tx, { tenantId, counterpartyId: customerId, asOf: ASOF })),
      );

      expect(Number(credit.facts.OVERDUE_DAYS)).toBeGreaterThanOrEqual(60);
      expect(credit.isBlocked).toBe(true);
    });

    it('refuses a block with no stated reason', async () => {
      const refused = await runInTenantScope({ tenantId }, () =>
        upsertCreditProfile({
          tenantId,
          audit: audit(),
          counterpartyId: customerId,
          graceDays: 0,
          holdAfterDays: 60,
          isBlocked: true,
          blockReason: '   ',
        }),
      );

      expect(refused.ok).toBe(false);
    });

    it('refuses a hold threshold earlier than the grace period', async () => {
      // It would stop selling to a customer the company agreed not to chase yet.
      const refused = await runInTenantScope({ tenantId }, () =>
        upsertCreditProfile({
          tenantId,
          audit: audit(),
          counterpartyId: customerId,
          graceDays: 90,
          holdAfterDays: 30,
          isBlocked: false,
        }),
      );

      expect(refused.ok).toBe(false);
    });
  });

  describe('the credit hold', () => {
    async function creditRule() {
      return runInTenantScope({ tenantId }, () =>
        createApprovalRule({
          tenantId,
          audit: audit(),
          nameAr: 'حجز ائتماني — متأخرات فوق 60 يوماً',
          nameEn: 'Credit hold over 60 days',
          documentType: 'SALES_ORDER',
          priority: 1,
          conditions: [{ field: 'OVERDUE_DAYS', operator: 'GT', value: '60' }],
          approverRoleIds: [cfoRoleId],
          excludeInitiator: false,
        }),
      );
    }

    async function placeOrder(): Promise<string> {
      const created = await runInTenantScope({ tenantId }, () =>
        createTradeDocument({
          tenantId,
          userId: clerkId,
          audit: audit(),
          type: 'SALES_ORDER',
          counterpartyId: customerId,
          branchId,
          // The facts are read as at the document's own date, so the test is not
          // wall-clock dependent.
          documentDate: '2026-06-30',
          lines: [{ productId, quantity: '1', unitPrice: '100' }],
        }),
      );
      if (!created.ok) throw new Error(created.error.messageEn);
      return created.value.id;
    }

    it('lets an order through for a customer who is current', async () => {
      await creditRule();
      await invoice({ dueDate: '2026-07-15', total: '1000' });

      const orderId = await placeOrder();
      const result = await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId: clerkId,
          audit: audit(),
          id: orderId,
          status: 'CONFIRMED',
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('CONFIRMED');
    });

    it('holds an order for a customer more than 60 days overdue', async () => {
      // The feature as asked for: the rep raises the order, the system stops it.
      await creditRule();
      await invoice({ dueDate: '2026-01-15', total: '5000' }); // 166 days

      const orderId = await placeOrder();
      const result = await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId: clerkId,
          audit: audit(),
          id: orderId,
          status: 'CONFIRMED',
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('PENDING_APPROVAL');
      expect(result.value.held?.ruleNameAr).toBe('حجز ائتماني — متأخرات فوق 60 يوماً');

      // And the evidence names the actual age, so the CFO can see why.
      const request = await prisma.approvalRequest.findFirstOrThrow({
        where: { tenantId, entityId: orderId },
        select: { triggeredBy: true },
      });
      const evidence = request.triggeredBy as { matched: { field: string; actual: string }[] };
      expect(evidence.matched[0]?.field).toBe('OVERDUE_DAYS');
      expect(evidence.matched[0]?.actual).toBe('166');
    });

    it('does not hold when grace pulls the age under the threshold', async () => {
      // 166 days raw, 46 after 120 days' grace. The rule reads the aged figure, not the raw one.
      await creditRule();
      await invoice({ dueDate: '2026-01-15', total: '5000' });

      await runInTenantScope({ tenantId }, () =>
        upsertCreditProfile({
          tenantId,
          audit: audit(),
          counterpartyId: customerId,
          graceDays: 120,
          holdAfterDays: 200,
          isBlocked: false,
        }),
      );

      const orderId = await placeOrder();
      const result = await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId: clerkId,
          audit: audit(),
          id: orderId,
          status: 'CONFIRMED',
        }),
      );

      expect(result.ok && result.value.status).toBe('CONFIRMED');
    });

    it('holds a blocked customer even with nothing overdue', async () => {
      await creditRule();
      await runInTenantScope({ tenantId }, () =>
        upsertCreditProfile({
          tenantId,
          audit: audit(),
          counterpartyId: customerId,
          graceDays: 0,
          holdAfterDays: 61,
          isBlocked: true,
          blockReason: 'نزاع',
        }),
      );

      const orderId = await placeOrder();
      const result = await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId: clerkId,
          audit: audit(),
          id: orderId,
          status: 'CONFIRMED',
        }),
      );

      expect(result.ok && result.value.status).toBe('PENDING_APPROVAL');
    });
  });

  describe('the statement of account', () => {
    it('closes at the same balance the ageing totals to', async () => {
      // The two sit side by side on the sheet a customer receives. A fils between them and
      // they stop reading and start arguing.
      await invoice({ dueDate: '2026-05-15', total: '3000' });
      await invoice({ dueDate: '2026-01-15', total: '5000', paid: '1000' });
      // The receipt behind that `paid: '1000'`. Without it the fixture describes a state the
      // application cannot produce, and the two halves of the sheet would disagree for a
      // reason that says nothing about the code.
      await receipt('1000', '2026-02-01');

      const statement = await runInTenantScope({ tenantId }, () =>
        getStatementOfAccount({
          tenantId,
          counterpartyId: customerId,
          fromDate: new Date('2026-01-01T00:00:00.000Z'),
          asOf: ASOF,
        }),
      );

      expect(statement.ok).toBe(true);
      if (!statement.ok) return;

      // Closing balance runs the debits and credits; the ageing sums the open items. Two
      // routes to one number.
      expect(Number(statement.value.closingBalance)).toBe(7000);
      expect(Number(statement.value.aging.total)).toBe(7000);
    });

    it('folds everything before the window into the opening balance', async () => {
      await invoice({ dueDate: '2025-06-15', total: '9000' });
      await invoice({ dueDate: '2026-05-15', total: '3000' });

      const statement = await runInTenantScope({ tenantId }, () =>
        getStatementOfAccount({
          tenantId,
          counterpartyId: customerId,
          fromDate: new Date('2026-01-01T00:00:00.000Z'),
          asOf: ASOF,
        }),
      );

      if (!statement.ok) return;

      // A statement that starts at zero and omits the history does not reconcile to the ledger.
      expect(Number(statement.value.openingBalance)).toBe(9000);
      expect(statement.value.lines).toHaveLength(1);
      expect(Number(statement.value.closingBalance)).toBe(12000);
    });

    it('is byte-identical when rendered twice', async () => {
      // Same-day rows sorted by date alone would come back in whatever order the two queries
      // returned. A document somebody has argued about must not reorder itself on reprint.
      await invoice({ dueDate: '2026-05-15', total: '1000' });
      await invoice({ dueDate: '2026-05-15', total: '2000' });
      await invoice({ dueDate: '2026-05-15', total: '3000' });

      const render = async () =>
        runInTenantScope({ tenantId }, () =>
          getStatementOfAccount({
            tenantId,
            counterpartyId: customerId,
            fromDate: new Date('2026-01-01T00:00:00.000Z'),
            asOf: ASOF,
          }),
        );

      const first = await render();
      const second = await render();

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('refuses an unknown customer', async () => {
      const missing = await runInTenantScope({ tenantId }, () =>
        getStatementOfAccount({
          tenantId,
          counterpartyId: '00000000-0000-0000-0000-000000000000',
          fromDate: new Date('2026-01-01T00:00:00.000Z'),
          asOf: ASOF,
        }),
      );

      expect(missing.ok).toBe(false);
    });
  });
});
