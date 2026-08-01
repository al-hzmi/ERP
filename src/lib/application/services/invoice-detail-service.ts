import { encodeQr, qrToSvgPath } from '@/lib/domain/zatca/qr-matrix';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';
import type { ZatcaStatus } from '@/lib/commercial/zatca-labels';

/**
 * Everything one invoice screen needs, in one read.
 *
 * The page shows the document, its lines, the journal posting created it, and the ZATCA
 * envelope — four things that were previously only reachable through four different screens,
 * three of which do not exist. Loading them together is one transaction rather than four, and
 * more importantly it means the page either renders completely or not at all: a detail screen
 * that shows a total but cannot say whether it posted is worse than no screen.
 *
 * The QR is rasterised to an SVG path here, on the server. Doing it in the browser would ship
 * a QR encoder to every client for a picture most of them never print.
 */

export interface InvoiceLineView {
  readonly lineNumber: number;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly descriptionAr: string | null;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
  readonly taxRate: string;
  readonly taxAmount: string;
  readonly lineTotal: string;
}

export interface JournalLineView {
  readonly accountCode: string;
  readonly accountNameAr: string;
  readonly debit: string;
  readonly credit: string;
}

export interface InvoiceDetail {
  readonly id: string;
  readonly documentNumber: string;
  readonly status: string;
  readonly issueDate: Date;
  readonly dueDate: Date;
  readonly currency: string;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly paidAmount: string;
  readonly outstanding: string;
  readonly notes: string | null;

  readonly customerCode: string;
  readonly customerNameAr: string;
  readonly customerVatNumber: string | null;
  readonly customerAddress: string | null;

  readonly branchNameAr: string;
  readonly warehouseId: string | null;
  readonly warehouseNameAr: string | null;
  /** True when a line needs stock, so posting will demand a warehouse. */
  readonly hasStockItems: boolean;

  readonly sellerNameAr: string;
  readonly sellerVatNumber: string | null;
  readonly sellerCrn: string | null;

  readonly lines: readonly InvoiceLineView[];

  readonly journalNumber: string | null;
  readonly journalLines: readonly JournalLineView[];

  readonly zatca: {
    readonly status: ZatcaStatus;
    readonly icv: string;
    readonly invoiceUuid: string;
    readonly invoiceHash: string;
    readonly invoiceTypeCode: string;
    readonly isSigned: boolean;
    /** The QR as an SVG path, ready to drop into a `<svg viewBox="0 0 extent extent">`. */
    readonly qrPath: string;
    readonly qrExtent: number;
  } | null;
}

export async function getInvoiceDetail(
  tenantId: string,
  documentId: string,
): Promise<InvoiceDetail | null> {
  return withTenantRead(async (tx) => {
    const document = await tx.document.findFirst({
      where: { id: documentId, tenantId, type: 'SALES_INVOICE' },
      include: {
        counterparty: {
          select: { code: true, nameAr: true, taxNumber: true, addressJson: true },
        },
        branch: { select: { nameAr: true } },
        warehouse: { select: { id: true, nameAr: true } },
        lines: {
          orderBy: { lineNumber: 'asc' },
          include: { product: { select: { sku: true, nameAr: true, isStockItem: true } } },
        },
        zatca: true,
        tenant: { select: { nameAr: true, vatNumber: true, crn: true } },
      },
    });

    if (document === null) return null;

    // The journal is found by reference rather than by a foreign key: posting writes the link
    // one way, and a draft has no journal at all.
    const journal = await tx.journal.findFirst({
      where: { tenantId, referenceId: documentId },
      include: {
        lines: {
          orderBy: { lineNumber: 'asc' },
          include: { account: { select: { code: true, nameAr: true } } },
        },
      },
    });

    const address = document.counterparty.addressJson as { city?: string } | null;

    let zatca: InvoiceDetail['zatca'] = null;
    if (document.zatca !== null) {
      // A payload that will not encode must not take the page down with it — the invoice is
      // still worth showing without its QR, and the empty path renders as an empty square
      // rather than a stack trace.
      let qrPath = '';
      let qrExtent = 0;
      try {
        const matrix = encodeQr(document.zatca.qrCode);
        const svg = qrToSvgPath(matrix);
        qrPath = svg.path;
        qrExtent = svg.extent;
      } catch {
        qrPath = '';
        qrExtent = 0;
      }

      zatca = {
        status: document.zatca.status as ZatcaStatus,
        icv: document.zatca.icv.toString(),
        invoiceUuid: document.zatca.invoiceUuid,
        invoiceHash: document.zatca.invoiceHash,
        invoiceTypeCode: document.zatca.invoiceTypeCode,
        isSigned: document.zatca.signature !== null,
        qrPath,
        qrExtent,
      };
    }

    return {
      id: document.id,
      documentNumber: document.documentNumber,
      status: document.status,
      issueDate: document.issueDate,
      dueDate: document.dueDate,
      currency: document.currency,
      subtotal: document.subtotal.toFixed(4),
      discountTotal: document.discountTotal.toFixed(4),
      taxTotal: document.taxTotal.toFixed(4),
      total: document.total.toFixed(4),
      paidAmount: document.paidAmount.toFixed(4),
      outstanding: document.total.minus(document.paidAmount).toFixed(4),
      notes: document.notes,

      customerCode: document.counterparty.code,
      customerNameAr: document.counterparty.nameAr,
      customerVatNumber: document.counterparty.taxNumber,
      customerAddress: address?.city ?? null,

      branchNameAr: document.branch.nameAr,
      warehouseId: document.warehouse?.id ?? null,
      warehouseNameAr: document.warehouse?.nameAr ?? null,
      hasStockItems: document.lines.some((line) => line.product.isStockItem),

      sellerNameAr: document.tenant.nameAr,
      sellerVatNumber: document.tenant.vatNumber,
      sellerCrn: document.tenant.crn,

      lines: document.lines.map((line) => ({
        lineNumber: line.lineNumber,
        productSku: line.product.sku,
        productNameAr: line.product.nameAr,
        descriptionAr: line.descriptionAr,
        quantity: line.quantity.toFixed(4),
        unitPrice: line.unitPrice.toFixed(4),
        discount: line.discount.toFixed(4),
        taxRate: line.taxRate.toFixed(2),
        taxAmount: line.taxAmount.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4),
      })),

      journalNumber: journal?.entryNumber ?? null,
      journalLines:
        journal?.lines.map((line) => ({
          accountCode: line.account.code,
          accountNameAr: line.account.nameAr,
          debit: line.debit.toFixed(4),
          credit: line.credit.toFixed(4),
        })) ?? [],

      zatca,
    };
  });
}
