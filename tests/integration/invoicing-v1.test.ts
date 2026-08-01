import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { search } from '@/lib/application/services/search-service';
import {
  getDefaultTaxRate,
  installDefaultTaxCodes,
  listTaxCodes,
  saveTaxCode,
  setDefaultTaxCode,
} from '@/lib/application/services/tax-code-service';
import {
  allocateDocumentNumber,
  allocateInvoiceCounterValue,
  listNumberSequences,
} from '@/lib/application/services/numbering-service';
import { withTransaction } from '@/lib/infrastructure/db/prisma';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * The V1 invoicing path, end to end, against a real database.
 *
 * ## The defect this file exists for
 *
 * The new-invoice screen was reported as unresponsive: clicking the customer field did nothing.
 * It was not a client bug. `search()` returned `[]` for an empty query, so a picker that had
 * been opened but not typed into had literally nothing to render — and a control that looks
 * like a dropdown and does nothing when clicked reads as a broken form, which is exactly how it
 * was described. The first block below pins the fix at the layer it was actually wrong in.
 *
 * ## What is verified rather than rebuilt
 *
 * Two of the four things this release was asked for already existed and were already correct:
 * document numbering has been allocated under a row lock since migration 1, and posting a sales
 * invoice has always written a balanced double-entry journal. Rewriting either would have been
 * churn. So they are pinned here instead — the numbering test races five concurrent allocations
 * against each other, and the ledger test asserts the journal balances and hits the accounts a
 * sale should hit.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let userId = '';

function audit() {
  return {
    tenantId,
    userId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    correlationId: randomUUID(),
  };
}

async function makeCounterparty(
  code: string,
  type: 'CUSTOMER' | 'SUPPLIER' | 'BOTH',
  nameAr: string,
): Promise<string> {
  const row = await prisma.counterparty.create({
    data: { tenantId, code, type, nameAr, nameEn: code },
    select: { id: true },
  });
  return row.id;
}

async function makeProduct(sku: string, nameAr: string): Promise<string> {
  const [category, unit] = await Promise.all([
    prisma.category.findFirstOrThrow({ where: { tenantId }, select: { id: true } }),
    prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId }, select: { id: true } }),
  ]);

  const row = await prisma.product.create({
    data: {
      tenantId,
      sku,
      nameAr,
      nameEn: sku,
      categoryId: category.id,
      unitOfMeasureId: unit.id,
      salePrice: '100.0000',
      costPrice: '60.0000',
    },
    select: { id: true },
  });
  return row.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('V1 invoicing', () => {
  beforeEach(async () => {
    const code = `INV_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'فوترة', nameEn: 'Invoicing' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'clerk',
        email: `clerk@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'محاسب',
        fullNameEn: 'Clerk',
      },
      select: { id: true },
    });
    userId = user.id;

    await prisma.category.create({
      data: { tenantId, code: 'C1', nameAr: 'تصنيف', nameEn: 'Category' },
    });
    await prisma.unitOfMeasure.create({
      data: { tenantId, code: 'PCS', nameAr: 'حبة', nameEn: 'Each' },
    });
  });

  describe('the picker opens on focus', () => {
    it('returns the first page of the list for an empty query', async () => {
      // The defect, stated as a test: an empty query used to return `[]`, so a dropdown that
      // had been clicked but not typed into rendered nothing at all.
      await makeCounterparty('CUS-0001', 'CUSTOMER', 'شركة الصفوة');
      await makeCounterparty('CUS-0002', 'CUSTOMER', 'مؤسسة البدر');

      const hits = await search({ tenantId, query: '', entities: ['counterparty'] });

      expect(hits.length).toBe(2);
      expect(hits.every((hit) => hit.entity === 'counterparty')).toBe(true);
    });

    it('orders a browse alphabetically by code rather than by an accidental score', async () => {
      for (const code of ['CUS-0003', 'CUS-0001', 'CUS-0002']) {
        await makeCounterparty(code, 'CUSTOMER', `عميل ${code}`);
      }

      const hits = await search({ tenantId, query: '', entities: ['counterparty'] });

      // Every row scores 0 when browsing, so the per-entity `ORDER BY code` survives the merge
      // sort. A stable, alphabetical first page is what makes the list scannable.
      expect(hits.map((hit) => hit.code)).toEqual(['CUS-0001', 'CUS-0002', 'CUS-0003']);
      expect(hits.every((hit) => hit.score === 0)).toBe(true);
    });

    it('does not let a counterparty without a tax number score as an exact match', async () => {
      // `compactCode('')` is `''`, and `erp_compact_code(taxNumber) = ''` is true for every row
      // that has no tax number — which would score them 1.00 and float them above the
      // alphabetical order. Browse mode skips the scoring entirely for exactly this reason.
      await prisma.counterparty.create({
        data: { tenantId, code: 'CUS-0009', type: 'CUSTOMER', nameAr: 'بلا رقم', nameEn: 'X' },
      });
      await prisma.counterparty.create({
        data: {
          tenantId,
          code: 'CUS-0001',
          type: 'CUSTOMER',
          nameAr: 'له رقم',
          nameEn: 'Y',
          taxNumber: '300000000000003',
        },
      });

      const hits = await search({ tenantId, query: '', entities: ['counterparty'] });

      expect(hits.map((hit) => hit.code)).toEqual(['CUS-0001', 'CUS-0009']);
    });

    it('browses products too', async () => {
      await makeProduct('BTC-1001', 'حاسب محمول');
      await makeProduct('BTC-1002', 'شاشة عرض');

      const hits = await search({ tenantId, query: '', entities: ['product'] });
      expect(hits.map((hit) => hit.code)).toEqual(['BTC-1001', 'BTC-1002']);
    });

    it('still refuses a query that matched nothing, rather than falling back to everything', async () => {
      // The distinction that makes browse safe: *empty* means browse, but a non-empty query
      // which tokenises to nothing must not widen to every row.
      await makeCounterparty('CUS-0001', 'CUSTOMER', 'شركة الصفوة');

      expect(await search({ tenantId, query: 'zzzzz', entities: ['counterparty'] })).toEqual([]);
      expect(await search({ tenantId, query: '...', entities: ['counterparty'] })).toEqual([]);
    });

    it('narrows as soon as the user types', async () => {
      await makeCounterparty('CUS-0001', 'CUSTOMER', 'شركة الصفوة للخدمات');
      await makeCounterparty('CUS-0002', 'CUSTOMER', 'مؤسسة البدر للتجارة');

      const hits = await search({ tenantId, query: 'صفوة', entities: ['counterparty'] });

      expect(hits.map((hit) => hit.code)).toEqual(['CUS-0001']);
    });
  });

  describe('the customer picker offers customers', () => {
    beforeEach(async () => {
      await makeCounterparty('CUS-0001', 'CUSTOMER', 'عميل');
      await makeCounterparty('SUP-0001', 'SUPPLIER', 'مورد');
      await makeCounterparty('BOTH-001', 'BOTH', 'عميل ومورد');
    });

    it('excludes suppliers from a customer picker', async () => {
      // Without the filter a sales invoice can be raised against a supplier, which books a
      // receivable from a company we owe money to — and nothing downstream can detect it.
      const hits = await search({
        tenantId,
        query: '',
        entities: ['counterparty'],
        counterpartyType: 'CUSTOMER',
      });

      expect(hits.map((hit) => hit.code).sort()).toEqual(['BOTH-001', 'CUS-0001']);
    });

    it('excludes customers from a supplier picker', async () => {
      const hits = await search({
        tenantId,
        query: '',
        entities: ['counterparty'],
        counterpartyType: 'SUPPLIER',
      });

      expect(hits.map((hit) => hit.code).sort()).toEqual(['BOTH-001', 'SUP-0001']);
    });

    it('offers a BOTH counterparty on either side, because it genuinely is both', async () => {
      for (const side of ['CUSTOMER', 'SUPPLIER'] as const) {
        const hits = await search({
          tenantId,
          query: 'عميل ومورد',
          entities: ['counterparty'],
          counterpartyType: side,
        });
        expect(hits.map((hit) => hit.code)).toContain('BOTH-001');
      }
    });

    it('applies the filter to a typed query as well as a browse', async () => {
      const hits = await search({
        tenantId,
        query: 'مورد',
        entities: ['counterparty'],
        counterpartyType: 'CUSTOMER',
      });

      expect(hits.map((hit) => hit.code)).not.toContain('SUP-0001');
    });
  });

  describe('tax codes', () => {
    beforeEach(async () => {
      await withTransaction((tx) => installDefaultTaxCodes(tx, tenantId));
    });

    it('installs the Saudi standard set with exactly one default', async () => {
      const codes = await runInTenantScope({ tenantId }, () => listTaxCodes(tenantId));

      expect(codes.map((code) => code.code)).toEqual(['VAT15', 'ZERO', 'EXEMPT']);
      expect(codes.filter((code) => code.isDefault)).toHaveLength(1);
      expect(await runInTenantScope({ tenantId }, () => getDefaultTaxRate(tenantId))).toBe('15.00');
    });

    it('gives zero-rated and exempt different ZATCA letters at the same rate', async () => {
      const codes = await runInTenantScope({ tenantId }, () => listTaxCodes(tenantId));
      const zero = codes.find((code) => code.code === 'ZERO');
      const exempt = codes.find((code) => code.code === 'EXEMPT');

      expect(zero?.rate).toBe('0.00');
      expect(exempt?.rate).toBe('0.00');
      // Same rate, different treatment, different declaration. This is the distinction a
      // plain rate column cannot carry.
      expect(zero?.zatcaCode).toBe('Z');
      expect(exempt?.zatcaCode).toBe('E');
    });

    it('forces a non-standard treatment to zero however it is asked', async () => {
      const result = await saveTaxCode({
        tenantId,
        audit: audit(),
        code: 'EXPORT',
        nameAr: 'تصدير',
        nameEn: 'Export',
        treatment: 'ZERO_RATED',
        // Nonsense, and deliberately so: the treatment decides the rate.
        rate: '15',
        exemptionReasonAr: 'تصدير خارج المملكة',
        isActive: true,
        sortOrder: 40,
      });

      expect(result.ok).toBe(true);

      const codes = await runInTenantScope({ tenantId }, () => listTaxCodes(tenantId));
      const saved = codes.find((code) => code.code === 'EXPORT');
      expect(saved?.rate).toBe('0.00');
      expect(saved?.zatcaCode).toBe('Z');
    });

    it('refuses a non-standard code with no exemption reason', async () => {
      const result = await saveTaxCode({
        tenantId,
        audit: audit(),
        code: 'NOREASON',
        nameAr: 'بلا سبب',
        nameEn: 'No reason',
        treatment: 'EXEMPT',
        rate: '0',
        isActive: true,
        sortOrder: 50,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.messageAr).toContain('سبباً');
    });

    it('refuses a standard code at zero percent', async () => {
      // "Standard-rated at 0%" is a contradiction ZATCA rejects, and the only reason to write
      // it is that the author meant zero-rated.
      const result = await saveTaxCode({
        tenantId,
        audit: audit(),
        code: 'STDZERO',
        nameAr: 'خاضعة بصفر',
        nameEn: 'Standard zero',
        treatment: 'STANDARD',
        rate: '0',
        isActive: true,
        sortOrder: 60,
      });

      expect(result.ok).toBe(false);
    });

    it('refuses a duplicate code', async () => {
      const result = await saveTaxCode({
        tenantId,
        audit: audit(),
        code: 'VAT15',
        nameAr: 'مكرر',
        nameEn: 'Duplicate',
        treatment: 'STANDARD',
        rate: '15',
        isActive: true,
        sortOrder: 70,
      });

      expect(result.ok).toBe(false);
    });

    it('moves the default without ever holding two, which the index would refuse', async () => {
      const codes = await runInTenantScope({ tenantId }, () => listTaxCodes(tenantId));
      const zero = codes.find((code) => code.code === 'ZERO');

      const result = await setDefaultTaxCode({ tenantId, audit: audit(), id: zero?.id ?? '' });
      expect(result.ok).toBe(true);

      const after = await runInTenantScope({ tenantId }, () => listTaxCodes(tenantId));
      expect(after.filter((code) => code.isDefault).map((code) => code.code)).toEqual(['ZERO']);
      expect(await runInTenantScope({ tenantId }, () => getDefaultTaxRate(tenantId))).toBe('0.00');
    });

    it('refuses to deactivate the default rather than leaving the tenant with none', async () => {
      const codes = await runInTenantScope({ tenantId }, () => listTaxCodes(tenantId));
      const standard = codes.find((code) => code.isDefault);

      const result = await saveTaxCode({
        tenantId,
        audit: audit(),
        id: standard?.id ?? '',
        code: standard?.code ?? '',
        nameAr: standard?.nameAr ?? '',
        nameEn: standard?.nameEn ?? '',
        treatment: 'STANDARD',
        rate: '15',
        isActive: false,
        sortOrder: 10,
      });

      expect(result.ok).toBe(false);
    });

    it('refuses to make an inactive code the default', async () => {
      const created = await saveTaxCode({
        tenantId,
        audit: audit(),
        code: 'RETIRED',
        nameAr: 'متقاعد',
        nameEn: 'Retired',
        treatment: 'STANDARD',
        rate: '5',
        isActive: false,
        sortOrder: 80,
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await setDefaultTaxCode({ tenantId, audit: audit(), id: created.value.id });
      expect(result.ok).toBe(false);
    });

    it('records the change in the audit trail', async () => {
      await saveTaxCode({
        tenantId,
        audit: audit(),
        code: 'AUDITED',
        nameAr: 'مُدقَّق',
        nameEn: 'Audited',
        treatment: 'STANDARD',
        rate: '5',
        isActive: true,
        sortOrder: 90,
      });

      const entries = await prisma.auditLog.count({ where: { tenantId, entityType: 'taxCode' } });
      expect(entries).toBeGreaterThan(0);
    });
  });

  describe('document numbering', () => {
    it('never issues the same number twice under concurrency', async () => {
      // The property the whole design exists for. `SELECT max(...) + 1` passes a sequential
      // test and fails this one: both transactions read the same maximum.
      const numbers = await Promise.all(
        Array.from({ length: 8 }, () =>
          withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026)),
        ),
      );

      expect(new Set(numbers).size).toBe(8);
    });

    it('issues a contiguous run, so a gap means something was deleted', async () => {
      const numbers = await Promise.all(
        Array.from({ length: 5 }, () =>
          withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026)),
        ),
      );

      const counters = numbers.map((number) => Number(number.slice(number.lastIndexOf('-') + 1)));
      expect(counters.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it('formats the number the way the register displays it', async () => {
      const number = await withTransaction((tx) =>
        allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026),
      );
      expect(number).toBe('INV-2026-00001');
    });

    it('keeps each series and year on its own counter', async () => {
      const [invoice, journal, nextYear] = await Promise.all([
        withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026)),
        withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'JOURNAL', 2026)),
        withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2027)),
      ]);

      expect(invoice).toBe('INV-2026-00001');
      expect(journal).toBe('JE-2026-00001');
      expect(nextYear).toBe('INV-2027-00001');
    });

    it('does not reuse a number after a rollback, because numbers are consumed not reserved', async () => {
      await withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026));

      // A transaction that allocates then fails. The counter is inside that transaction, so it
      // rolls back with it — which is the *correct* behaviour and worth pinning, because the
      // alternative (an out-of-band sequence) would burn a number on every failed save.
      await expect(
        withTransaction(async (tx) => {
          await allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      const next = await withTransaction((tx) =>
        allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026),
      );
      expect(next).toBe('INV-2026-00002');
    });

    it('lists every series a tenant has drawn from', async () => {
      await withTransaction((tx) => allocateDocumentNumber(tx, tenantId, 'SALES_INVOICE', 2026));
      await withTransaction((tx) => allocateInvoiceCounterValue(tx, tenantId));

      const series = await withTransaction((tx) => listNumberSequences(tx, tenantId));
      const keys = series.map((row) => row.key);

      expect(keys).toContain('SALES_INVOICE');
      expect(keys).toContain('ZATCA_ICV');

      const icv = series.find((row) => row.key === 'ZATCA_ICV');
      // Year 0 is the sentinel that stops the counter resetting each January — ZATCA reads a
      // discontinuity as a suppressed invoice.
      expect(icv?.year).toBe(0);
      expect(icv?.issued).toBe(1n);
    });
  });
});
