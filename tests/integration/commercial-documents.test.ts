import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFiscalYear,
  listFiscalYears,
  setPeriodStatus,
} from '@/lib/application/services/fiscal-calendar-service';
import {
  createCurrency,
  listCurrencies,
  recordExchangeRate,
  setCurrencyActive,
  setFunctionalCurrency,
} from '@/lib/application/services/currency-service';
import {
  createAssemblyOrder,
  createPaymentTerm,
  createPriceList,
  getAssemblyOrder,
  setAssemblyStatus,
  setPriceListLine,
} from '@/lib/application/services/commercial-setup-service';
import {
  createTradeDocument,
  getTradeDocument,
  listTradeDocuments,
  setTradeDocumentStatus,
} from '@/lib/application/services/trade-document-service';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * Migration 011's four features, against a real database.
 *
 * The tests worth having here are the ones about *refusals and derived values*, not the happy
 * path — a create that inserts a row is not interesting, and the register would show it.
 *
 * Specifically:
 *   - Periods close in order, and closing out of turn is refused.
 *   - Exactly one currency is functional, and setting a new one moves the flag rather than
 *     adding a second claimant.
 *   - A rate is a dated fact: the same pair and date twice is refused, not overwritten.
 *   - Header totals equal the sum of the lines that produced them.
 *   - A confirmed document's lines are frozen — by the database, not by the service.
 *   - An assembly order cannot be made of itself.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let userId = '';
let branchId = '';
let warehouseId = '';
let customerId = '';
let supplierId = '';
let productA = '';
let productB = '';

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

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('commercial documents', () => {
  beforeEach(async () => {
    const code = `TRD_${randomUUID().slice(0, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { code, nameAr: 'تجاري', nameEn: 'Trade' },
      select: { id: true },
    });
    tenantId = tenant.id;

    const user = await prisma.user.create({
      data: {
        tenantId,
        username: 'clerk',
        email: `clerk@${code}.spec`,
        passwordHash: 'x',
        fullNameAr: 'موظف',
        fullNameEn: 'Clerk',
      },
      select: { id: true },
    });
    userId = user.id;

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const warehouse = await prisma.warehouse.create({
      data: { tenantId, branchId, code: 'WH1', nameAr: 'الرئيسي', nameEn: 'Main' },
      select: { id: true },
    });
    warehouseId = warehouse.id;

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

    const makeProduct = async (sku: string): Promise<string> => {
      const created = await prisma.product.create({
        data: {
          tenantId,
          sku,
          nameAr: `صنف ${sku}`,
          nameEn: sku,
          categoryId: category.id,
          unitOfMeasureId: uom.id,
          salePrice: '100.0000',
          costPrice: '60.0000',
        },
        select: { id: true },
      });
      return created.id;
    };

    productA = await makeProduct('SKU-A');
    productB = await makeProduct('SKU-B');

    const [customer, supplier] = await Promise.all([
      prisma.counterparty.create({
        data: { tenantId, code: 'CU1', type: 'CUSTOMER', nameAr: 'عميل', nameEn: 'Customer' },
        select: { id: true },
      }),
      prisma.counterparty.create({
        data: { tenantId, code: 'SU1', type: 'SUPPLIER', nameAr: 'مورد', nameEn: 'Supplier' },
        select: { id: true },
      }),
    ]);
    customerId = customer.id;
    supplierId = supplier.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  Fiscal calendar
  // ───────────────────────────────────────────────────────────────────────────

  describe('fiscal calendar', () => {
    it('creates a year with twelve periods whose dates tile the year exactly', async () => {
      const created = await runInTenantScope({ tenantId }, () =>
        createFiscalYear({ tenantId, audit: audit(), year: 2027 }),
      );

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.periods).toBe(12);

      const years = await runInTenantScope({ tenantId }, () => listFiscalYears(tenantId));
      const year = years.find((row) => row.year === 2027);

      expect(year?.periods).toHaveLength(12);
      // February in a non-leap year, which a naive "add 30 days" gets wrong.
      expect(year?.periods[1]?.startDate).toBe('2027-02-01');
      expect(year?.periods[1]?.endDate).toBe('2027-02-28');
      expect(year?.periods[11]?.endDate).toBe('2027-12-31');
    });

    it('gets February right in a leap year too', async () => {
      await runInTenantScope({ tenantId }, () =>
        createFiscalYear({ tenantId, audit: audit(), year: 2028 }),
      );

      const years = await runInTenantScope({ tenantId }, () => listFiscalYears(tenantId));
      expect(years.find((row) => row.year === 2028)?.periods[1]?.endDate).toBe('2028-02-29');
    });

    it('refuses a duplicate year', async () => {
      await runInTenantScope({ tenantId }, () =>
        createFiscalYear({ tenantId, audit: audit(), year: 2027 }),
      );

      const again = await runInTenantScope({ tenantId }, () =>
        createFiscalYear({ tenantId, audit: audit(), year: 2027 }),
      );

      expect(again.ok).toBe(false);
    });

    it('refuses to close a period while an earlier one is open', async () => {
      await runInTenantScope({ tenantId }, () =>
        createFiscalYear({ tenantId, audit: audit(), year: 2027 }),
      );

      const years = await runInTenantScope({ tenantId }, () => listFiscalYears(tenantId));
      const periods = years.find((row) => row.year === 2027)?.periods ?? [];
      const march = periods[2];
      expect(march).toBeDefined();
      if (march === undefined) return;

      // Closing March while January and February are open would certify a cumulative figure
      // that the two open periods can still change.
      const outOfTurn = await runInTenantScope({ tenantId }, () =>
        setPeriodStatus({ tenantId, audit: audit(), periodId: march.id, status: 'CLOSED' }),
      );

      expect(outOfTurn.ok).toBe(false);
    });

    it('closes in order and reopens', async () => {
      await runInTenantScope({ tenantId }, () =>
        createFiscalYear({ tenantId, audit: audit(), year: 2027 }),
      );

      const years = await runInTenantScope({ tenantId }, () => listFiscalYears(tenantId));
      const january = years.find((row) => row.year === 2027)?.periods[0];
      expect(january).toBeDefined();
      if (january === undefined) return;

      const closed = await runInTenantScope({ tenantId }, () =>
        setPeriodStatus({ tenantId, audit: audit(), periodId: january.id, status: 'CLOSED' }),
      );
      expect(closed.ok).toBe(true);

      const reopened = await runInTenantScope({ tenantId }, () =>
        setPeriodStatus({ tenantId, audit: audit(), periodId: january.id, status: 'OPEN' }),
      );
      expect(reopened.ok).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  Currencies
  // ───────────────────────────────────────────────────────────────────────────

  describe('currencies', () => {
    it('keeps exactly one functional currency when the flag moves', async () => {
      const sar = await runInTenantScope({ tenantId }, () =>
        createCurrency({
          tenantId,
          audit: audit(),
          code: 'SAR',
          nameAr: 'ريال',
          nameEn: 'Riyal',
          symbol: 'ر.س',
          minorUnits: 2,
        }),
      );
      const usd = await runInTenantScope({ tenantId }, () =>
        createCurrency({
          tenantId,
          audit: audit(),
          code: 'USD',
          nameAr: 'دولار',
          nameEn: 'Dollar',
          symbol: '$',
          minorUnits: 2,
        }),
      );

      expect(sar.ok && usd.ok).toBe(true);
      if (!sar.ok || !usd.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setFunctionalCurrency({ tenantId, audit: audit(), currencyId: sar.value.id }),
      );
      await runInTenantScope({ tenantId }, () =>
        setFunctionalCurrency({ tenantId, audit: audit(), currencyId: usd.value.id }),
      );

      const currencies = await runInTenantScope({ tenantId }, () => listCurrencies(tenantId));
      const functional = currencies.filter((currency) => currency.isFunctional);

      expect(functional).toHaveLength(1);
      expect(functional[0]?.code).toBe('USD');
    });

    it('refuses to deactivate the functional currency', async () => {
      const sar = await runInTenantScope({ tenantId }, () =>
        createCurrency({
          tenantId,
          audit: audit(),
          code: 'SAR',
          nameAr: 'ريال',
          nameEn: 'Riyal',
          symbol: 'ر.س',
          minorUnits: 2,
        }),
      );
      if (!sar.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setFunctionalCurrency({ tenantId, audit: audit(), currencyId: sar.value.id }),
      );

      const refused = await runInTenantScope({ tenantId }, () =>
        setCurrencyActive({ tenantId, audit: audit(), currencyId: sar.value.id, isActive: false }),
      );

      expect(refused.ok).toBe(false);
    });

    it('refuses a second rate for the same pair and date', async () => {
      const sar = await runInTenantScope({ tenantId }, () =>
        createCurrency({
          tenantId,
          audit: audit(),
          code: 'SAR',
          nameAr: 'ريال',
          nameEn: 'Riyal',
          symbol: 'ر.س',
          minorUnits: 2,
        }),
      );
      const usd = await runInTenantScope({ tenantId }, () =>
        createCurrency({
          tenantId,
          audit: audit(),
          code: 'USD',
          nameAr: 'دولار',
          nameEn: 'Dollar',
          symbol: '$',
          minorUnits: 2,
        }),
      );
      if (!sar.ok || !usd.ok) return;

      const first = await runInTenantScope({ tenantId }, () =>
        recordExchangeRate({
          tenantId,
          audit: audit(),
          fromCurrencyId: usd.value.id,
          toCurrencyId: sar.value.id,
          rate: '3.75',
          validOn: '2027-01-15',
        }),
      );
      expect(first.ok).toBe(true);

      // Re-stating a historical rate would silently re-value every document translated with it.
      const duplicate = await runInTenantScope({ tenantId }, () =>
        recordExchangeRate({
          tenantId,
          audit: audit(),
          fromCurrencyId: usd.value.id,
          toCurrencyId: sar.value.id,
          rate: '3.80',
          validOn: '2027-01-15',
        }),
      );
      expect(duplicate.ok).toBe(false);
    });

    it('refuses a currency against itself', async () => {
      const sar = await runInTenantScope({ tenantId }, () =>
        createCurrency({
          tenantId,
          audit: audit(),
          code: 'SAR',
          nameAr: 'ريال',
          nameEn: 'Riyal',
          symbol: 'ر.س',
          minorUnits: 2,
        }),
      );
      if (!sar.ok) return;

      const refused = await runInTenantScope({ tenantId }, () =>
        recordExchangeRate({
          tenantId,
          audit: audit(),
          fromCurrencyId: sar.value.id,
          toCurrencyId: sar.value.id,
          rate: '1',
          validOn: '2027-01-15',
        }),
      );

      expect(refused.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  Trade documents
  // ───────────────────────────────────────────────────────────────────────────

  describe('trade documents', () => {
    async function quotation() {
      return runInTenantScope({ tenantId }, () =>
        createTradeDocument({
          tenantId,
          userId,
          audit: audit(),
          type: 'QUOTATION',
          counterpartyId: customerId,
          branchId,
          documentDate: '2027-03-01',
          expectedDate: '2027-03-31',
          lines: [
            { productId: productA, quantity: '10', unitPrice: '100', taxRate: '15' },
            {
              productId: productB,
              quantity: '5',
              unitPrice: '200',
              discountPercent: '10',
              taxRate: '15',
            },
          ],
        }),
      );
    }

    it('stores header totals that equal the sum of the lines', async () => {
      const created = await quotation();
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const document = await runInTenantScope({ tenantId }, () =>
        getTradeDocument({ tenantId, id: created.value.id }),
      );
      expect(document).not.toBeNull();
      if (document === null) return;

      // Line 1: 10 x 100 = 1000 net, 150 tax.
      // Line 2: 5 x 200 = 1000, less 10% = 900 net, 135 tax.
      expect(document.subtotal).toBe('1900');
      expect(document.taxAmount).toBe('285');
      expect(document.totalAmount).toBe('2185');

      const lineSum = document.lines.reduce((sum, line) => sum + Number(line.lineTotal), 0);
      expect(lineSum.toFixed(4)).toBe(Number(document.totalAmount).toFixed(4));
    });

    it('numbers documents in their own series', async () => {
      const created = await quotation();
      if (!created.ok) return;

      expect(created.value.documentNumber).toMatch(/^QT-2027-\d{5}$/);
    });

    it('refuses a supplier on a customer document', async () => {
      const wrongSide = await runInTenantScope({ tenantId }, () =>
        createTradeDocument({
          tenantId,
          userId,
          audit: audit(),
          type: 'QUOTATION',
          counterpartyId: supplierId,
          branchId,
          documentDate: '2027-03-01',
          lines: [{ productId: productA, quantity: '1', unitPrice: '10' }],
        }),
      );

      expect(wrongSide.ok).toBe(false);
    });

    it('accepts a supplier on a purchase order', async () => {
      const order = await runInTenantScope({ tenantId }, () =>
        createTradeDocument({
          tenantId,
          userId,
          audit: audit(),
          type: 'PURCHASE_ORDER',
          counterpartyId: supplierId,
          branchId,
          documentDate: '2027-03-01',
          lines: [{ productId: productA, quantity: '1', unitPrice: '10' }],
        }),
      );

      expect(order.ok).toBe(true);
      if (!order.ok) return;
      expect(order.value.documentNumber).toMatch(/^PO-2027-\d{5}$/);
    });

    it('refuses a document with no lines', async () => {
      const empty = await runInTenantScope({ tenantId }, () =>
        createTradeDocument({
          tenantId,
          userId,
          audit: audit(),
          type: 'QUOTATION',
          counterpartyId: customerId,
          branchId,
          documentDate: '2027-03-01',
          lines: [],
        }),
      );

      expect(empty.ok).toBe(false);
    });

    it('freezes the lines once confirmed, in the database', async () => {
      const created = await quotation();
      if (!created.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId,
          audit: audit(),
          id: created.value.id,
          status: 'CONFIRMED',
        }),
      );

      const line = await prisma.tradeDocumentLine.findFirst({
        where: { documentId: created.value.id },
        select: { id: true },
      });
      expect(line).not.toBeNull();
      if (line === null) return;

      // Straight through Prisma, bypassing the service entirely — the freeze has to be the
      // database's rule, not a convention the service is trusted to keep.
      await expect(
        prisma.tradeDocumentLine.update({
          where: { id: line.id },
          data: { unitPrice: '1' },
        }),
      ).rejects.toThrow();
    });

    it('refuses an illegal status transition', async () => {
      const created = await quotation();
      if (!created.ok) return;

      // DRAFT cannot jump straight to COMPLETED: a document nobody confirmed was never agreed.
      const skipped = await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId,
          audit: audit(),
          id: created.value.id,
          status: 'COMPLETED',
        }),
      );
      expect(skipped.ok).toBe(false);

      await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId,
          audit: audit(),
          id: created.value.id,
          status: 'CANCELLED',
        }),
      );

      // CANCELLED is terminal.
      const revived = await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId,
          audit: audit(),
          id: created.value.id,
          status: 'CONFIRMED',
        }),
      );
      expect(revived.ok).toBe(false);
    });

    it('posts nothing to the ledger', async () => {
      const before = await prisma.journal.count({ where: { tenantId } });

      const created = await quotation();
      if (!created.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setTradeDocumentStatus({
          tenantId,
          userId,
          audit: audit(),
          id: created.value.id,
          status: 'CONFIRMED',
        }),
      );

      // The documented boundary, asserted rather than trusted: confirming a commercial
      // document must not move the books.
      expect(await prisma.journal.count({ where: { tenantId } })).toBe(before);
    });

    it('lists only the requested type', async () => {
      await quotation();
      await runInTenantScope({ tenantId }, () =>
        createTradeDocument({
          tenantId,
          userId,
          audit: audit(),
          type: 'PURCHASE_ORDER',
          counterpartyId: supplierId,
          branchId,
          documentDate: '2027-03-01',
          lines: [{ productId: productA, quantity: '1', unitPrice: '10' }],
        }),
      );

      const quotations = await runInTenantScope({ tenantId }, () =>
        listTradeDocuments({ tenantId, type: 'QUOTATION' }),
      );

      expect(quotations).toHaveLength(1);
      expect(quotations[0]?.type).toBe('QUOTATION');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  Price lists, payment terms, assembly orders
  // ───────────────────────────────────────────────────────────────────────────

  describe('commercial setup', () => {
    it('re-prices a product rather than adding a second row at the same tier', async () => {
      const list = await runInTenantScope({ tenantId }, () =>
        createPriceList({
          tenantId,
          audit: audit(),
          code: 'PL1',
          nameAr: 'قائمة',
          nameEn: 'List',
          validFrom: '2027-01-01',
        }),
      );
      if (!list.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setPriceListLine({
          tenantId,
          audit: audit(),
          priceListId: list.value.id,
          productId: productA,
          unitPrice: '90',
        }),
      );
      await runInTenantScope({ tenantId }, () =>
        setPriceListLine({
          tenantId,
          audit: audit(),
          priceListId: list.value.id,
          productId: productA,
          unitPrice: '85',
        }),
      );

      const lines = await prisma.priceListLine.findMany({
        where: { priceListId: list.value.id },
        select: { unitPrice: true },
      });

      expect(lines).toHaveLength(1);
      expect(lines[0]?.unitPrice.toString()).toBe('85');
    });

    it('keeps quantity tiers apart', async () => {
      const list = await runInTenantScope({ tenantId }, () =>
        createPriceList({
          tenantId,
          audit: audit(),
          code: 'PL2',
          nameAr: 'قائمة',
          nameEn: 'List',
          validFrom: '2027-01-01',
        }),
      );
      if (!list.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setPriceListLine({
          tenantId,
          audit: audit(),
          priceListId: list.value.id,
          productId: productA,
          unitPrice: '90',
          minQuantity: '1',
        }),
      );
      await runInTenantScope({ tenantId }, () =>
        setPriceListLine({
          tenantId,
          audit: audit(),
          priceListId: list.value.id,
          productId: productA,
          unitPrice: '80',
          minQuantity: '100',
        }),
      );

      expect(await prisma.priceListLine.count({ where: { priceListId: list.value.id } })).toBe(2);
    });

    it('refuses a discount window longer than the payment term', async () => {
      const refused = await runInTenantScope({ tenantId }, () =>
        createPaymentTerm({
          tenantId,
          audit: audit(),
          code: 'NET30',
          nameAr: 'صافي ٣٠',
          nameEn: 'Net 30',
          netDays: 30,
          discountDays: 45,
          discountPercent: '2',
        }),
      );

      expect(refused.ok).toBe(false);
    });

    it('accepts a well-formed early-settlement discount', async () => {
      const created = await runInTenantScope({ tenantId }, () =>
        createPaymentTerm({
          tenantId,
          audit: audit(),
          code: 'NET30',
          nameAr: 'صافي ٣٠',
          nameEn: 'Net 30',
          netDays: 30,
          discountDays: 10,
          discountPercent: '2',
        }),
      );

      expect(created.ok).toBe(true);
    });

    it('refuses an assembly order made of itself', async () => {
      const refused = await runInTenantScope({ tenantId }, () =>
        createAssemblyOrder({
          tenantId,
          userId,
          audit: audit(),
          productId: productA,
          quantity: '10',
          warehouseId,
          orderDate: '2027-04-01',
          components: [{ productId: productA, quantityPerUnit: '1' }],
        }),
      );

      expect(refused.ok).toBe(false);
    });

    it('multiplies component quantities by the order quantity', async () => {
      const order = await runInTenantScope({ tenantId }, () =>
        createAssemblyOrder({
          tenantId,
          userId,
          audit: audit(),
          productId: productA,
          quantity: '10',
          warehouseId,
          orderDate: '2027-04-01',
          components: [{ productId: productB, quantityPerUnit: '3' }],
        }),
      );
      expect(order.ok).toBe(true);
      if (!order.ok) return;

      const detail = await runInTenantScope({ tenantId }, () =>
        getAssemblyOrder({ tenantId, id: order.value.id }),
      );

      expect(detail?.components[0]?.quantityPerUnit).toBe('3');
      expect(detail?.components[0]?.totalRequired).toBe('30');
    });

    it('completes an assembly order without moving any stock', async () => {
      const order = await runInTenantScope({ tenantId }, () =>
        createAssemblyOrder({
          tenantId,
          userId,
          audit: audit(),
          productId: productA,
          quantity: '10',
          warehouseId,
          orderDate: '2027-04-01',
          components: [{ productId: productB, quantityPerUnit: '3' }],
        }),
      );
      if (!order.ok) return;

      const movementsBefore = await prisma.inventoryMovement.count({ where: { tenantId } });

      const completed = await runInTenantScope({ tenantId }, () =>
        setAssemblyStatus({ tenantId, audit: audit(), id: order.value.id, status: 'COMPLETED' }),
      );
      expect(completed.ok).toBe(true);

      // The documented boundary. If assembly ever does move stock, this test is where that
      // change announces itself rather than surfacing as a valuation nobody can reconcile.
      expect(await prisma.inventoryMovement.count({ where: { tenantId } })).toBe(movementsBefore);
    });

    it('refuses to close an assembly order twice', async () => {
      const order = await runInTenantScope({ tenantId }, () =>
        createAssemblyOrder({
          tenantId,
          userId,
          audit: audit(),
          productId: productA,
          quantity: '1',
          warehouseId,
          orderDate: '2027-04-01',
          components: [{ productId: productB, quantityPerUnit: '1' }],
        }),
      );
      if (!order.ok) return;

      await runInTenantScope({ tenantId }, () =>
        setAssemblyStatus({ tenantId, audit: audit(), id: order.value.id, status: 'COMPLETED' }),
      );

      const again = await runInTenantScope({ tenantId }, () =>
        setAssemblyStatus({ tenantId, audit: audit(), id: order.value.id, status: 'CANCELLED' }),
      );

      expect(again.ok).toBe(false);
    });
  });
});
