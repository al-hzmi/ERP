import { buildSalesInvoiceJournal, type InvoiceLineFacts } from '@/lib/domain/accounting/posting-rules';
import { createDomainEvent, type DomainEvent } from '@/lib/domain/shared/domain-event';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { checkSegregationOfDuties } from '@/lib/infrastructure/auth/segregation-of-duties';
import type { RequestContext } from '@/lib/infrastructure/auth/request-context';
import { fromMoney } from '@/lib/infrastructure/db/decimal-mapper';
import { withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';
import { issueStock } from '../services/inventory-service';
import { persistJournalEntry } from '../services/journal-service';
import { loadPostingContext } from '../services/tenant-context-loader';
import { generateZatcaInvoice } from '../services/zatca-service';

/**
 * Posting a sales invoice — the operation that touches every module at once.
 *
 * In one serialisable transaction it must:
 *   1. authorise the user and enforce segregation of duties,
 *   2. refuse if the customer would breach their credit limit,
 *   3. issue the goods, valuing them under the tenant's costing policy,
 *   4. recognise revenue, VAT and cost of sales as one balanced journal,
 *   5. move the customer's receivable balance,
 *   6. generate the ZATCA e-invoice with its hash chained to the previous one,
 *   7. write the audit trail and queue the domain events.
 *
 * Either all of that happens or none of it does. There is no intermediate state
 * in which stock has left the warehouse but revenue was never recognised — which
 * is exactly the state most homegrown systems spend their weekends reconciling.
 */

export interface PostSalesInvoiceInput {
  readonly documentId: string;
  /** Optional override; defaults to the document's own issue date. */
  readonly postingDate?: string;
}

export interface PostSalesInvoiceOutput {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly journalId: string;
  readonly journalNumber: string;
  readonly total: string;
  readonly cogsTotal: string;
  readonly zatcaQrCode: string | null;
  readonly warnings: readonly string[];
}

export async function postSalesInvoice(
  context: RequestContext,
  input: PostSalesInvoiceInput,
): Promise<Result<PostSalesInvoiceOutput, DomainError>> {
  const permitted = context.permissions.require('sales.invoice', 'post');
  if (!permitted.ok) return permitted;

  return withTransaction(async (tx) => execute(tx, context, input));
}

async function execute(
  tx: TransactionClient,
  context: RequestContext,
  input: PostSalesInvoiceInput,
): Promise<Result<PostSalesInvoiceOutput, DomainError>> {
  const warnings: string[] = [];

  // ── 1. Load the document with everything the posting needs ────────────────
  const document = await tx.document.findUnique({
    where: { id: input.documentId },
    include: {
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          product: {
            select: {
              id: true,
              sku: true,
              nameAr: true,
              nameEn: true,
              categoryId: true,
              isStockItem: true,
              costingMethod: true,
            },
          },
        },
      },
      counterparty: {
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          creditLimit: true,
          balance: true,
          taxNumber: true,
          code: true,
        },
      },
      warehouse: { select: { id: true, nameAr: true, nameEn: true } },
      branch: { select: { id: true, nameAr: true } },
    },
  });

  if (document === null || document.tenantId !== context.tenantId) {
    return err(DomainErrors.notFound('الفاتورة', 'Invoice', input.documentId));
  }

  if (document.type !== 'SALES_INVOICE') {
    return err(
      DomainErrors.validation(
        'هذا المستند ليس فاتورة مبيعات.',
        'This document is not a sales invoice.',
      ),
    );
  }

  if (document.isPosted) {
    return err(DomainErrors.documentAlreadyPosted(document.documentNumber));
  }

  if (document.status === 'VOID') {
    return err(DomainErrors.documentVoided(document.documentNumber));
  }

  if (document.lines.length === 0) {
    return err(DomainErrors.emptyDocument('الفاتورة', 'An invoice'));
  }

  // ── 2. Segregation of duties ──────────────────────────────────────────────
  const settingsAndPosting = await loadPostingContext(tx, context.tenantId, document.branchId);
  if (!settingsAndPosting.ok) return settingsAndPosting;
  const { settings, posting } = settingsAndPosting.value;

  const sod = checkSegregationOfDuties({
    step: 'post',
    userId: context.userId,
    actors: {
      createdById: document.createdById,
      approvedById: document.approvedById,
      postedById: document.postedById,
    },
    enforce: settings.enforceSoD,
    isSuperAdmin: context.isSuperAdmin,
  });
  if (!sod.ok) return sod;

  const currency = document.currency;
  const postingDate =
    input.postingDate !== undefined
      ? DateOnly.create(input.postingDate)
      : ok(DateOnly.fromDate(document.issueDate));
  if (!postingDate.ok) return postingDate;

  // ── 3. Credit limit ───────────────────────────────────────────────────────
  const creditLimit = Money.of(
    document.counterparty.creditLimit.toFixed(4),
    settings.functionalCurrency,
  );
  const currentBalance = Money.of(
    document.counterparty.balance.toFixed(4),
    settings.functionalCurrency,
  );
  const invoiceTotalFunctional = Money.of(document.total.toFixed(4), currency).convertTo(
    settings.functionalCurrency,
    document.exchangeRate.toFixed(6),
  );
  const projectedBalance = currentBalance.add(invoiceTotalFunctional);

  if (creditLimit.isPositive && projectedBalance.greaterThan(creditLimit)) {
    // A hard stop for ordinary users; a recorded override for those authorised
    // to accept the exposure. Silently allowing it would make the limit decorative.
    if (!context.permissions.can('sales.invoice', 'approve')) {
      return err(
        DomainErrors.creditLimitExceeded(
          document.counterparty.nameAr,
          document.counterparty.nameEn,
          creditLimit.toFixed(2),
          projectedBalance.toFixed(2),
        ),
      );
    }
    warnings.push(
      `تم تجاوز الحد الائتماني للعميل ${document.counterparty.nameAr}: الرصيد المتوقع ${projectedBalance.toFixed(2)} مقابل حد ${creditLimit.toFixed(2)}.`,
    );
  }

  // ── 4. Issue the goods and capture cost of sales ──────────────────────────
  const events: DomainEvent[] = [];
  const lineFacts: InvoiceLineFacts[] = [];

  for (const line of document.lines) {
    const quantity = Quantity.of(line.quantity.toFixed(4));
    const unitPrice = Money.of(line.unitPrice.toFixed(4), currency);
    const discount = Money.of(line.discount.toFixed(4), currency);
    const taxAmount = Money.of(line.taxAmount.toFixed(4), currency);
    const grossAmount = unitPrice.multiply(quantity.toString());

    let cogsAmount = Money.zero(settings.functionalCurrency);

    if (line.product.isStockItem) {
      if (document.warehouseId === null || document.warehouse === null) {
        return err(
          DomainErrors.validation(
            'يجب تحديد المستودع لفاتورة تحتوي على أصناف مخزنية.',
            'A warehouse is required for an invoice containing stock items.',
            'warehouseId',
          ),
        );
      }

      const issued = await issueStock(tx, {
        tenantId: context.tenantId,
        branchId: document.branchId,
        warehouseId: document.warehouseId,
        productId: line.productId,
        date: postingDate.value,
        createdById: context.userId,
        quantity,
        costingMethod: line.product.costingMethod ?? settings.costingMethod,
        allowNegativeStock: settings.allowNegativeStock,
        currency: settings.functionalCurrency,
        movementType: 'OUT',
        referenceType: 'DOCUMENT',
        referenceId: document.id,
        notes: `فاتورة مبيعات ${document.documentNumber}`,
        productNameAr: line.product.nameAr,
        productNameEn: line.product.nameEn,
        warehouseNameAr: document.warehouse.nameAr,
        warehouseNameEn: document.warehouse.nameEn,
        ...(line.batchNumber !== null ? { batchNumber: line.batchNumber } : {}),
        ...(line.serialNumber !== null ? { serialNumber: line.serialNumber } : {}),
      });

      if (!issued.ok) return issued;

      cogsAmount = issued.value.totalCost;
      events.push(...issued.value.events);

      // Persist the resolved cost on the line so a margin report never has to
      // recompute history that has since moved on.
      await tx.$executeRaw`
        UPDATE "document_lines"
           SET "cogsAmount" = ${fromMoney(cogsAmount)}::decimal
         WHERE "id" = ${line.id}::uuid
      `;
    }

    lineFacts.push({
      productId: line.productId,
      ...(line.product.categoryId !== null ? { categoryId: line.product.categoryId } : {}),
      grossAmount,
      discount,
      taxAmount,
      cogsAmount,
      isStockItem: line.product.isStockItem,
      description: line.descriptionAr ?? line.product.nameAr,
    });
  }

  // ── 5. Recognise revenue, VAT and cost of sales ───────────────────────────
  const journalDraft = buildSalesInvoiceJournal(
    {
      documentId: document.id,
      documentNumber: document.documentNumber,
      counterpartyId: document.counterpartyId,
      date: postingDate.value,
      currency,
      exchangeRate: document.exchangeRate.toFixed(6),
      lines: lineFacts,
    },
    posting,
  );

  if (!journalDraft.ok) return journalDraft;

  const validated = journalDraft.value.validate();
  if (!validated.ok) return validated;

  const audit = {
    tenantId: context.tenantId,
    userId: context.userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    sessionId: context.sessionId,
    correlationId: context.correlationId,
  };

  const journal = await persistJournalEntry(tx, validated.value, {
    audit,
    createdById: context.userId,
    postImmediately: true,
  });

  if (!journal.ok) return journal;
  events.push(...journal.value.events);

  // ── 6. Flip the document and move the receivable ──────────────────────────
  await tx.document.update({
    where: { id: document.id },
    data: {
      status: 'POSTED',
      isPosted: true,
      postedAt: new Date(),
      postedById: context.userId,
    },
  });

  await tx.counterparty.update({
    where: { id: document.counterpartyId },
    data: { balance: { increment: fromMoney(invoiceTotalFunctional) } },
  });

  events.push(
    createDomainEvent(
      'counterparty.balance.changed',
      document.counterpartyId,
      {
        counterpartyId: document.counterpartyId,
        previousBalance: currentBalance.toString(),
        newBalance: projectedBalance.toString(),
        reason: `SALES_INVOICE:${document.documentNumber}`,
      },
      { correlationId: context.correlationId, tenantId: context.tenantId, userId: context.userId },
    ),
  );

  // ── 7. ZATCA e-invoice ────────────────────────────────────────────────────
  const zatca = await generateZatcaInvoice(tx, {
    tenantId: context.tenantId,
    documentId: document.id,
    documentNumber: document.documentNumber,
    issueDate: document.issueDate,
    sellerNameAr: settings.nameAr,
    sellerVatNumber: settings.vatNumber,
    buyerNameAr: document.counterparty.nameAr,
    buyerVatNumber: document.counterparty.taxNumber,
    totalWithVat: Money.of(document.total.toFixed(4), currency),
    vatTotal: Money.of(document.taxTotal.toFixed(4), currency),
    currency,
    lines: document.lines.map((line) => ({
      nameAr: line.descriptionAr ?? line.product.nameAr,
      quantity: Quantity.of(line.quantity.toFixed(4)),
      unitPrice: Money.of(line.unitPrice.toFixed(4), currency),
      taxRate: line.taxRate.toFixed(2),
      lineTotal: Money.of(line.lineTotal.toFixed(4), currency),
    })),
  });

  if (!zatca.ok) {
    // A ZATCA failure is a compliance problem, not a bookkeeping one — surface it
    // as a warning and let the resubmission job retry, rather than blocking a
    // legitimate sale that is already accounted for.
    warnings.push(zatca.error.messageAr);
  }

  // ── 8. Audit and events ───────────────────────────────────────────────────
  const cogsTotal = Money.sum(
    lineFacts.map((line) => line.cogsAmount),
    settings.functionalCurrency,
  );

  await recordAudit(
    tx,
    audit,
    'POST',
    { entityType: 'Document', entityId: document.id },
    {
      metadata: {
        documentNumber: document.documentNumber,
        type: document.type,
        counterpartyCode: document.counterparty.code,
        total: document.total.toFixed(4),
        currency,
        journalNumber: journal.value.entryNumber,
        cogsTotal: cogsTotal.toString(),
        creditLimitOverridden: warnings.length > 0,
      },
    },
  );

  events.push(
    createDomainEvent(
      'sales.invoice.posted',
      document.id,
      {
        documentId: document.id,
        documentNumber: document.documentNumber,
        counterpartyId: document.counterpartyId,
        branchId: document.branchId,
        warehouseId: document.warehouseId,
        issueDate: DateOnly.fromDate(document.issueDate).toString(),
        subtotal: document.subtotal.toFixed(4),
        discountTotal: document.discountTotal.toFixed(4),
        taxTotal: document.taxTotal.toFixed(4),
        total: document.total.toFixed(4),
        currency,
        exchangeRate: document.exchangeRate.toFixed(6),
        lines: document.lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity.toFixed(4),
          unitPrice: line.unitPrice.toFixed(4),
          discount: line.discount.toFixed(4),
          taxRate: line.taxRate.toFixed(2),
          taxAmount: line.taxAmount.toFixed(4),
          lineTotal: line.lineTotal.toFixed(4),
        })),
      },
      { correlationId: context.correlationId, tenantId: context.tenantId, userId: context.userId },
    ),
  );

  await eventBus.enqueue(tx, events);

  return ok({
    documentId: document.id,
    documentNumber: document.documentNumber,
    journalId: journal.value.journalId,
    journalNumber: journal.value.entryNumber,
    total: document.total.toFixed(4),
    cogsTotal: cogsTotal.toString(),
    zatcaQrCode: zatca.ok ? zatca.value.qrCode : null,
    warnings,
  });
}
