import { Prisma } from '@prisma/client';
import type { TradeDocumentStatus, TradeDocumentType } from '@prisma/client';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { allocateDocumentNumber } from './numbering-service';

/**
 * Quotations, sales orders, purchase orders and sales returns.
 *
 * One service for four documents. They are the same shape — a counterparty, some dates, some
 * priced lines — and differ only in what the document *means*, so four services would be four
 * places for the same rounding rule and the same status machine to drift apart.
 *
 * ## None of this posts
 *
 * Confirming a sales order reserves no stock and raises no receivable. Confirming a purchase
 * order commits nothing to a supplier account. A sales return recorded here writes no credit
 * note — the accounting side of a return is `SALES_CREDIT_NOTE` on `documents`, which posts,
 * and which this does not touch.
 *
 * That is a deliberate boundary, not an unfinished one. These are commercial documents: the
 * paperwork that precedes and follows an invoice. Making them post would mean deciding when a
 * quotation becomes revenue, which is the question invoicing already answers.
 *
 * ## Arithmetic
 *
 * Line total is `quantity × unitPrice × (1 − discount) × (1 + tax)`, rounded once at the line.
 * This is *not* `calculateInvoice` from the domain layer, and the difference matters: that
 * function allocates header-level discounts across lines by largest remainder and feeds the
 * ledger. Nothing here reaches the ledger, so it uses the simpler rule — and says so, rather
 * than letting someone assume a quotation total will match the invoice it becomes to the fils.
 *
 * ## The status machine
 *
 *   DRAFT → CONFIRMED → COMPLETED
 *     └────────┴──────→ CANCELLED
 *
 * Lines are editable in DRAFT only, enforced by a trigger rather than here: a confirmed order
 * is what the counterparty agreed to, and a service-level check is one bypassed by any other
 * writer.
 */

export interface TradeDocumentDefinition {
  readonly titleAr: string;
  readonly descriptionAr: string;
  readonly counterpartyLabelAr: string;
  /** Which side of the trade — decides whether the picker offers customers or suppliers. */
  readonly counterpartyKind: 'CUSTOMER' | 'SUPPLIER';
  readonly expectedDateLabelAr: string;
  readonly sequenceKey: 'QUOTATION' | 'SALES_ORDER' | 'PURCHASE_ORDER' | 'SALES_RETURN';
  readonly resource: string;
  readonly basePath: string;
  /** Said on the screen, so nobody infers a posting that does not happen. */
  readonly postingNoteAr: string;
}

export const TRADE_DOCUMENTS: Record<TradeDocumentType, TradeDocumentDefinition> = {
  QUOTATION: {
    titleAr: 'عروض الأسعار',
    descriptionAr: 'عروض مقدَّمة للعملاء — سعر مقترح بصلاحية محددة',
    counterpartyLabelAr: 'العميل',
    counterpartyKind: 'CUSTOMER',
    expectedDateLabelAr: 'صالح حتى',
    sequenceKey: 'QUOTATION',
    resource: 'sales.invoice',
    basePath: '/sales/quotations',
    postingNoteAr: 'عرض السعر لا يُرحَّل محاسبياً ولا يحجز مخزوناً — هو وثيقة تجارية فقط.',
  },
  SALES_ORDER: {
    titleAr: 'أوامر البيع',
    descriptionAr: 'طلبات عملاء مؤكَّدة بانتظار التسليم والفوترة',
    counterpartyLabelAr: 'العميل',
    counterpartyKind: 'CUSTOMER',
    expectedDateLabelAr: 'تاريخ التسليم المتوقع',
    sequenceKey: 'SALES_ORDER',
    resource: 'sales.invoice',
    basePath: '/sales/orders',
    postingNoteAr: 'تأكيد الأمر لا يحجز مخزوناً ولا ينشئ ذمة مدينة — الفوترة هي ما يُرحِّل.',
  },
  PURCHASE_ORDER: {
    titleAr: 'أوامر الشراء',
    descriptionAr: 'طلبات شراء صادرة للموردين بانتظار الاستلام',
    counterpartyLabelAr: 'المورد',
    counterpartyKind: 'SUPPLIER',
    expectedDateLabelAr: 'تاريخ الاستلام المتوقع',
    sequenceKey: 'PURCHASE_ORDER',
    resource: 'procurement.invoice',
    basePath: '/procurement/orders',
    postingNoteAr: 'أمر الشراء لا يُرحَّل ولا يزيد المخزون — الاستلام والفاتورة هما ما يفعلان ذلك.',
  },
  SALES_RETURN: {
    titleAr: 'مرتجعات المبيعات',
    descriptionAr: 'بضاعة مرتجعة من العملاء — تسجيل وتتبُّع',
    counterpartyLabelAr: 'العميل',
    counterpartyKind: 'CUSTOMER',
    expectedDateLabelAr: 'تاريخ الاستلام',
    sequenceKey: 'SALES_RETURN',
    resource: 'sales.invoice',
    basePath: '/sales/returns',
    postingNoteAr:
      'تسجيل المرتجع لا يُصدر إشعاراً دائناً ولا يُعيد البضاعة للمخزون — الإشعار الدائن هو ما يُرحِّل.',
  },
};

export const STATUS_LABELS_AR: Record<TradeDocumentStatus, string> = {
  DRAFT: 'مسودة',
  CONFIRMED: 'مؤكَّد',
  COMPLETED: 'منفَّذ',
  CANCELLED: 'ملغى',
};

export interface TradeDocumentLineRow {
  readonly id: string;
  readonly lineNumber: number;
  readonly productId: string;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountPercent: string;
  readonly taxRate: string;
  readonly lineTotal: string;
}

export interface TradeDocumentRow {
  readonly id: string;
  readonly documentNumber: string;
  readonly type: TradeDocumentType;
  readonly status: TradeDocumentStatus;
  readonly counterpartyId: string;
  readonly counterpartyCode: string;
  readonly counterpartyNameAr: string;
  readonly documentDate: string;
  readonly expectedDate: string | null;
  readonly currency: string;
  readonly subtotal: string;
  readonly taxAmount: string;
  readonly totalAmount: string;
  readonly notes: string | null;
  readonly lineCount: number;
}

export interface TradeDocumentDetail extends TradeDocumentRow {
  readonly lines: readonly TradeDocumentLineRow[];
}

export async function listTradeDocuments(input: {
  tenantId: string;
  type: TradeDocumentType;
  status?: TradeDocumentStatus;
  limit?: number;
}): Promise<TradeDocumentRow[]> {
  return withTenantRead(async (tx) => {
    const rows = await tx.tradeDocument.findMany({
      where: {
        tenantId: input.tenantId,
        type: input.type,
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      orderBy: [{ documentDate: 'desc' }, { documentNumber: 'desc' }],
      take: input.limit ?? 100,
      select: {
        id: true,
        documentNumber: true,
        type: true,
        status: true,
        counterpartyId: true,
        documentDate: true,
        expectedDate: true,
        currency: true,
        subtotal: true,
        taxAmount: true,
        totalAmount: true,
        notes: true,
        counterparty: { select: { code: true, nameAr: true } },
        _count: { select: { lines: true } },
      },
    });

    return rows.map(toRow);
  });
}

export async function getTradeDocument(input: {
  tenantId: string;
  id: string;
}): Promise<TradeDocumentDetail | null> {
  return withTenantRead(async (tx) => {
    const row = await tx.tradeDocument.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: {
        id: true,
        documentNumber: true,
        type: true,
        status: true,
        counterpartyId: true,
        documentDate: true,
        expectedDate: true,
        currency: true,
        subtotal: true,
        taxAmount: true,
        totalAmount: true,
        notes: true,
        counterparty: { select: { code: true, nameAr: true } },
        _count: { select: { lines: true } },
        lines: {
          orderBy: { lineNumber: 'asc' },
          select: {
            id: true,
            lineNumber: true,
            productId: true,
            quantity: true,
            unitPrice: true,
            discountPercent: true,
            taxRate: true,
            lineTotal: true,
            product: { select: { sku: true, nameAr: true } },
          },
        },
      },
    });

    if (row === null) return null;

    return {
      ...toRow(row),
      lines: row.lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        productSku: line.product.sku,
        productNameAr: line.product.nameAr,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice.toString(),
        discountPercent: line.discountPercent.toString(),
        taxRate: line.taxRate.toString(),
        lineTotal: line.lineTotal.toString(),
      })),
    };
  });
}

interface RawDocument {
  id: string;
  documentNumber: string;
  type: TradeDocumentType;
  status: TradeDocumentStatus;
  counterpartyId: string;
  documentDate: Date;
  expectedDate: Date | null;
  currency: string;
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  notes: string | null;
  counterparty: { code: string; nameAr: string };
  _count: { lines: number };
}

function toRow(row: RawDocument): TradeDocumentRow {
  return {
    id: row.id,
    documentNumber: row.documentNumber,
    type: row.type,
    status: row.status,
    counterpartyId: row.counterpartyId,
    counterpartyCode: row.counterparty.code,
    counterpartyNameAr: row.counterparty.nameAr,
    documentDate: row.documentDate.toISOString().slice(0, 10),
    expectedDate: row.expectedDate?.toISOString().slice(0, 10) ?? null,
    currency: row.currency,
    subtotal: row.subtotal.toString(),
    taxAmount: row.taxAmount.toString(),
    totalAmount: row.totalAmount.toString(),
    notes: row.notes,
    lineCount: row._count.lines,
  };
}

export interface TradeDocumentLineInput {
  readonly productId: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountPercent?: string;
  readonly taxRate?: string;
}

/**
 * Creates a document in DRAFT with its lines.
 *
 * Totals are computed here and stored on the header. They are derived data — the lines are the
 * truth — and they exist so the register can draw a hundred rows without aggregating every line
 * of every document. `recomputeTotals` is the single place that writes them.
 */
export async function createTradeDocument(input: {
  tenantId: string;
  userId: string;
  audit: AuditContext;
  type: TradeDocumentType;
  counterpartyId: string;
  branchId: string;
  documentDate: string;
  expectedDate?: string | null;
  notes?: string;
  lines: readonly TradeDocumentLineInput[];
}): Promise<Result<{ id: string; documentNumber: string }, DomainError>> {
  if (input.lines.length === 0) {
    return err(
      DomainErrors.validation(
        'لا يمكن حفظ وثيقة بلا سطور.',
        'A document needs at least one line.',
        'lines',
      ),
    );
  }

  if (input.lines.length > 200) {
    return err(
      DomainErrors.validation(
        'الحد الأقصى 200 سطر للوثيقة الواحدة.',
        'A document may hold at most 200 lines.',
        'lines',
      ),
    );
  }

  const definition = TRADE_DOCUMENTS[input.type];

  return withTransaction(async (tx) => {
    const counterparty = await tx.counterparty.findFirst({
      where: { id: input.counterpartyId, tenantId: input.tenantId, isActive: true },
      select: { id: true, type: true, nameAr: true },
    });

    if (counterparty === null) {
      return err(
        DomainErrors.notFound(definition.counterpartyLabelAr, 'Counterparty', input.counterpartyId),
      );
    }

    // `BOTH` satisfies either side, which is the entire reason that value exists.
    if (counterparty.type !== 'BOTH' && counterparty.type !== definition.counterpartyKind) {
      return err(
        DomainErrors.validation(
          `${counterparty.nameAr} ليس ${definition.counterpartyLabelAr}.`,
          'The counterparty is of the wrong kind for this document.',
          'counterpartyId',
        ),
      );
    }

    const branch = await tx.branch.findFirst({
      where: { id: input.branchId, tenantId: input.tenantId },
      select: { id: true },
    });

    if (branch === null) {
      return err(DomainErrors.notFound('الفرع', 'Branch', input.branchId));
    }

    // One query for every product rather than one per line: a 200-line order should not be
    // 200 round trips before it is even validated.
    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, tenantId: input.tenantId },
      select: { id: true, sku: true },
    });

    if (products.length !== productIds.length) {
      const found = new Set(products.map((product) => product.id));
      const missing = productIds.find((id) => !found.has(id)) ?? '';
      return err(DomainErrors.notFound('الصنف', 'Product', missing));
    }

    const computed = input.lines.map((line, index) => {
      const total = lineTotal(line);
      return {
        lineNumber: index + 1,
        productId: line.productId,
        quantity: new Prisma.Decimal(line.quantity),
        unitPrice: new Prisma.Decimal(line.unitPrice),
        discountPercent: new Prisma.Decimal(line.discountPercent ?? '0'),
        taxRate: new Prisma.Decimal(line.taxRate ?? '0'),
        lineTotal: total.gross,
        net: total.net,
        tax: total.tax,
      };
    });

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: input.tenantId },
      select: { functionalCurrency: true },
    });

    const year = Number(input.documentDate.slice(0, 4));
    const documentNumber = await allocateDocumentNumber(
      tx,
      input.tenantId,
      definition.sequenceKey,
      year,
    );

    const document = await tx.tradeDocument.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        documentNumber,
        counterpartyId: counterparty.id,
        branchId: branch.id,
        documentDate: new Date(`${input.documentDate}T00:00:00.000Z`),
        expectedDate:
          input.expectedDate === undefined || input.expectedDate === null || input.expectedDate === ''
            ? null
            : new Date(`${input.expectedDate}T00:00:00.000Z`),
        currency: tenant.functionalCurrency,
        subtotal: computed.reduce((sum, line) => sum.plus(line.net), new Prisma.Decimal(0)),
        taxAmount: computed.reduce((sum, line) => sum.plus(line.tax), new Prisma.Decimal(0)),
        totalAmount: computed.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0)),
        notes: input.notes?.trim() === '' ? null : (input.notes?.trim() ?? null),
        createdById: input.userId,
      },
      select: { id: true, documentNumber: true },
    });

    await tx.tradeDocumentLine.createMany({
      data: computed.map((line) => ({
        tenantId: input.tenantId,
        documentId: document.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxRate: line.taxRate,
        lineTotal: line.lineTotal,
      })),
    });

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'tradeDocument', entityId: document.id },
      { metadata: { type: input.type, documentNumber: document.documentNumber, lines: computed.length } },
    );

    return ok(document);
  });
}

/**
 * `quantity × unitPrice`, less the discount, plus the tax.
 *
 * Rounded to four places at each step, which is the column's scale — so what is stored is what
 * was computed, rather than a value the database silently truncates on the way in.
 */
function lineTotal(line: TradeDocumentLineInput): {
  net: Prisma.Decimal;
  tax: Prisma.Decimal;
  gross: Prisma.Decimal;
} {
  const quantity = new Prisma.Decimal(line.quantity);
  const price = new Prisma.Decimal(line.unitPrice);
  const discount = new Prisma.Decimal(line.discountPercent ?? '0');
  const taxRate = new Prisma.Decimal(line.taxRate ?? '0');

  const gross = quantity.times(price);
  const net = gross
    .times(new Prisma.Decimal(100).minus(discount))
    .dividedBy(100)
    .toDecimalPlaces(4);
  const tax = net.times(taxRate).dividedBy(100).toDecimalPlaces(4);

  return { net, tax, gross: net.plus(tax) };
}

const ALLOWED_TRANSITIONS: Record<TradeDocumentStatus, readonly TradeDocumentStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Moves a document along its status machine.
 *
 * The transition table is data rather than a chain of `if`s so that the illegal moves are
 * visible in one place: COMPLETED and CANCELLED are terminal, and a document cannot go back to
 * DRAFT once its lines have been frozen — reopening it would let the agreed price change under
 * a number the counterparty already has.
 */
export async function setTradeDocumentStatus(input: {
  tenantId: string;
  audit: AuditContext;
  id: string;
  status: TradeDocumentStatus;
}): Promise<Result<{ id: string; status: TradeDocumentStatus }, DomainError>> {
  return withTransaction(async (tx) => {
    const document = await tx.tradeDocument.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: { id: true, status: true, documentNumber: true, type: true },
    });

    if (document === null) {
      return err(DomainErrors.notFound('الوثيقة', 'Document', input.id));
    }

    if (document.status === input.status) {
      return ok({ id: document.id, status: document.status });
    }

    if (!ALLOWED_TRANSITIONS[document.status].includes(input.status)) {
      return err(
        DomainErrors.validation(
          `لا يمكن نقل الوثيقة من "${STATUS_LABELS_AR[document.status]}" إلى "${STATUS_LABELS_AR[input.status]}".`,
          `Cannot move a ${document.status} document to ${input.status}.`,
          'status',
        ),
      );
    }

    await tx.tradeDocument.update({
      where: { id: document.id },
      data: { status: input.status, updatedAt: new Date() },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'tradeDocument', entityId: document.id },
      {
        metadata: {
          documentNumber: document.documentNumber,
          from: document.status,
          to: input.status,
        },
      },
    );

    return ok({ id: document.id, status: input.status });
  });
}
