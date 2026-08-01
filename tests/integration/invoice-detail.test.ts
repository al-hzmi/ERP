import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getInvoiceDetail } from '@/lib/application/services/invoice-detail-service';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * The invoice detail screen's data.
 *
 * Three properties matter here and none of them is "the fields come back".
 *
 * **Tenant scoping.** An id belonging to another tenant must be indistinguishable from one that
 * does not exist. Returning a different error for the two confirms the row is real, which is
 * the whole of what an enumeration attack needs.
 *
 * **The warehouse flag.** `hasStockItems` is what disables the Post button, and it must agree
 * with what the posting path actually refuses — a screen that enables a button the server will
 * reject is worse than one that never had the button.
 *
 * **The QR.** It is encoded server-side, so a payload that will not encode must not take the
 * page down with it.
 */

const databaseUrl = process.env['DATABASE_URL'];
const prisma = new PrismaClient();

let tenantId = '';
let otherTenantId = '';
let userId = '';
let branchId = '';
let warehouseId = '';
let customerId = '';
let stockProductId = '';
let serviceProductId = '';
let sequence = 0;

async function makeInvoice(input: {
  productId: string;
  warehouse: boolean;
  tenant?: string;
}): Promise<string> {
  sequence += 1;
  const owner = input.tenant ?? tenantId;

  const document = await prisma.document.create({
    data: {
      tenantId: owner,
      documentNumber: `INV-${String(sequence).padStart(5, '0')}`,
      type: 'SALES_INVOICE',
      status: 'DRAFT',
      counterpartyId: customerId,
      branchId,
      ...(input.warehouse ? { warehouseId } : {}),
      issueDate: new Date('2026-03-15T00:00:00.000Z'),
      dueDate: new Date('2026-04-15T00:00:00.000Z'),
      subtotal: '1000.0000',
      taxTotal: '150.0000',
      total: '1150.0000',
      createdById: userId,
      lines: {
        create: [
          {
            tenantId: owner,
            lineNumber: 1,
            productId: input.productId,
            quantity: '10.0000',
            unitPrice: '100.0000',
            taxRate: '15.00',
            taxAmount: '150.0000',
            lineTotal: '1150.0000',
          },
        ],
      },
    },
    select: { id: true },
  });

  return document.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(databaseUrl === undefined || databaseUrl === '')('invoice detail', () => {
  beforeEach(async () => {
    sequence = 0;
    const code = `DTL_${randomUUID().slice(0, 8)}`;

    const [tenant, other] = await Promise.all([
      prisma.tenant.create({
        data: { code, nameAr: 'شركة الاختبار', nameEn: 'Test', vatNumber: '300000000000003', crn: '1010000000' },
        select: { id: true },
      }),
      prisma.tenant.create({
        data: { code: `${code}_X`, nameAr: 'أخرى', nameEn: 'Other' },
        select: { id: true },
      }),
    ]);
    tenantId = tenant.id;
    otherTenantId = other.id;

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

    const branch = await prisma.branch.create({
      data: { tenantId, code: 'BR1', nameAr: 'الفرع', nameEn: 'Branch' },
      select: { id: true },
    });
    branchId = branch.id;

    const warehouse = await prisma.warehouse.create({
      data: { tenantId, branchId, code: 'WH1', nameAr: 'المستودع', nameEn: 'Warehouse' },
      select: { id: true },
    });
    warehouseId = warehouse.id;

    const customer = await prisma.counterparty.create({
      data: {
        tenantId,
        code: 'CUS-0001',
        type: 'CUSTOMER',
        nameAr: 'عميل',
        nameEn: 'Customer',
        taxNumber: '310000000000003',
      },
      select: { id: true },
    });
    customerId = customer.id;

    const [category, unit] = await Promise.all([
      prisma.category.create({
        data: { tenantId, code: 'C1', nameAr: 'تصنيف', nameEn: 'Category' },
        select: { id: true },
      }),
      prisma.unitOfMeasure.create({
        data: { tenantId, code: 'PCS', nameAr: 'حبة', nameEn: 'Each' },
        select: { id: true },
      }),
    ]);

    const [stock, service] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId,
          sku: 'STK-0001',
          nameAr: 'صنف مخزني',
          nameEn: 'Stock item',
          categoryId: category.id,
          unitOfMeasureId: unit.id,
          salePrice: '100.0000',
          costPrice: '60.0000',
          isStockItem: true,
        },
        select: { id: true },
      }),
      prisma.product.create({
        data: {
          tenantId,
          sku: 'SRV-0001',
          nameAr: 'خدمة',
          nameEn: 'Service',
          categoryId: category.id,
          unitOfMeasureId: unit.id,
          salePrice: '100.0000',
          costPrice: '60.0000',
          isStockItem: false,
        },
        select: { id: true },
      }),
    ]);
    stockProductId = stock.id;
    serviceProductId = service.id;
  });

  describe('tenant scoping', () => {
    it('returns null for another tenant, not the row', async () => {
      const id = await makeInvoice({ productId: stockProductId, warehouse: true });

      const seen = await runInTenantScope({ tenantId: otherTenantId }, () =>
        getInvoiceDetail(otherTenantId, id),
      );

      expect(seen).toBeNull();
    });

    it('returns null for an id that does not exist, the same way', async () => {
      // Identical answer to the case above, which is the point: the caller cannot tell a
      // forbidden invoice from an absent one.
      const seen = await runInTenantScope({ tenantId }, () =>
        getInvoiceDetail(tenantId, randomUUID()),
      );

      expect(seen).toBeNull();
    });
  });

  describe('the warehouse guard the Post button reads', () => {
    it('flags an invoice whose lines need stock', async () => {
      const id = await makeInvoice({ productId: stockProductId, warehouse: false });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      // Together these disable the button: stock items present, no warehouse chosen.
      expect(detail?.hasStockItems).toBe(true);
      expect(detail?.warehouseId).toBeNull();
    });

    it('does not flag a services-only invoice, which posts without a warehouse', async () => {
      const id = await makeInvoice({ productId: serviceProductId, warehouse: false });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      expect(detail?.hasStockItems).toBe(false);
    });

    it('reports the warehouse once one is chosen', async () => {
      const id = await makeInvoice({ productId: stockProductId, warehouse: true });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      expect(detail?.hasStockItems).toBe(true);
      expect(detail?.warehouseId).toBe(warehouseId);
      expect(detail?.warehouseNameAr).toBe('المستودع');
    });
  });

  describe('what the printed page needs', () => {
    it('carries both parties and both VAT numbers', async () => {
      const id = await makeInvoice({ productId: stockProductId, warehouse: true });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      // A tax invoice is not valid without the seller's registration, and a B2B one needs the
      // buyer's too — both go on the printed document.
      expect(detail?.sellerNameAr).toBe('شركة الاختبار');
      expect(detail?.sellerVatNumber).toBe('300000000000003');
      expect(detail?.sellerCrn).toBe('1010000000');
      expect(detail?.customerVatNumber).toBe('310000000000003');
    });

    it('returns amounts as exact strings, never as floats', async () => {
      const id = await makeInvoice({ productId: stockProductId, warehouse: true });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      expect(detail?.total).toBe('1150.0000');
      expect(detail?.taxTotal).toBe('150.0000');
      expect(detail?.outstanding).toBe('1150.0000');
      expect(typeof detail?.total).toBe('string');
    });

    it('has no ZATCA envelope and no journal while it is a draft', async () => {
      // Both appear at posting. A draft that showed a QR would be claiming an e-invoice was
      // issued for a document that has not been.
      const id = await makeInvoice({ productId: stockProductId, warehouse: true });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      expect(detail?.zatca).toBeNull();
      expect(detail?.journalNumber).toBeNull();
      expect(detail?.journalLines).toEqual([]);
    });

    it('lists the lines in order, with the product each one names', async () => {
      const id = await makeInvoice({ productId: stockProductId, warehouse: true });

      const detail = await runInTenantScope({ tenantId }, () => getInvoiceDetail(tenantId, id));

      expect(detail?.lines).toHaveLength(1);
      expect(detail?.lines[0]?.productSku).toBe('STK-0001');
      expect(detail?.lines[0]?.taxRate).toBe('15.00');
    });
  });
});
