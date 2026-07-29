import { buildPurchaseInvoiceJournal, type InvoiceLineFacts } from '@/lib/domain/accounting/posting-rules';
import { createDomainEvent, type DomainEvent } from '@/lib/domain/shared/domain-event';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { Quantity } from '@/lib/domain/shared/quantity';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import type { RequestContext } from '@/lib/infrastructure/auth/request-context';
import { checkSegregationOfDuties } from '@/lib/infrastructure/auth/segregation-of-duties';
import { fromMoney } from '@/lib/infrastructure/db/decimal-mapper';
import { withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';
import { receiveStock } from '../services/inventory-service';
import { persistJournalEntry } from '../services/journal-service';
import { loadPostingContext } from '../services/tenant-context-loader';

/**
 * Posting a purchase invoice.
 *
 * The mirror of the sales path, with one difference that matters: the unit cost
 * that enters inventory is the *net* purchase price — after trade discount,
 * before recoverable VAT. Capitalising the gross price would overstate inventory
 * and understate the VAT recoverable, and the error compounds through every
 * subsequent sale's cost of goods sold (IAS 2.11).
 */

export interface PostPurchaseInvoiceInput {
  readonly documentId: string;
  readonly postingDate?: string;
}

export interface PostPurchaseInvoiceOutput {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly journalId: string;
  readonly journalNumber: string;
  readonly total: string;
  readonly receivedLines: number;
}

export async function postPurchaseInvoice(
  context: RequestContext,
  input: PostPurchaseInvoiceInput,
): Promise<Result<PostPurchaseInvoiceOutput, DomainError>> {
  const permitted = context.permissions.require('procurement.invoice', 'post');
  if (!permitted.ok) return permitted;

  return withTransaction(async (tx) => execute(tx, context, input));
}

async function execute(
  tx: TransactionClient,
  context: RequestContext,
  input: PostPurchaseInvoiceInput,
): Promise<Result<PostPurchaseInvoiceOutput, DomainError>> {
  const document = await tx.document.findUnique({
    where: { id: input.documentId },
    include: {
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          product: {
            select: {
              id: true,
              nameAr: true,
              nameEn: true,
              categoryId: true,
              isStockItem: true,
              costingMethod: true,
            },
          },
        },
      },
      counterparty: { select: { id: true, code: true, nameAr: true, balance: true } },
      warehouse: { select: { id: true, nameAr: true, nameEn: true } },
    },
  });

  if (document === null || document.tenantId !== context.tenantId) {
    return err(DomainErrors.notFound('فاتورة المشتريات', 'Purchase invoice', input.documentId));
  }

  if (document.type !== 'PURCHASE_INVOICE') {
    return err(
      DomainErrors.validation(
        'هذا المستند ليس فاتورة مشتريات.',
        'This document is not a purchase invoice.',
      ),
    );
  }

  if (document.isPosted) return err(DomainErrors.documentAlreadyPosted(document.documentNumber));
  if (document.status === 'VOID') return err(DomainErrors.documentVoided(document.documentNumber));
  if (document.lines.length === 0) {
    return err(DomainErrors.emptyDocument('الفاتورة', 'An invoice'));
  }

  const loaded = await loadPostingContext(tx, context.tenantId, document.branchId);
  if (!loaded.ok) return loaded;
  const { settings, posting } = loaded.value;

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

  const postingDate =
    input.postingDate !== undefined
      ? DateOnly.create(input.postingDate)
      : ok(DateOnly.fromDate(document.issueDate));
  if (!postingDate.ok) return postingDate;

  const currency = document.currency;
  const exchangeRate = document.exchangeRate.toFixed(6);
  const events: DomainEvent[] = [];
  const lineFacts: InvoiceLineFacts[] = [];
  let receivedLines = 0;

  for (const line of document.lines) {
    const quantity = Quantity.of(line.quantity.toFixed(4));
    const unitPrice = Money.of(line.unitPrice.toFixed(4), currency);
    const discount = Money.of(line.discount.toFixed(4), currency);
    const taxAmount = Money.of(line.taxAmount.toFixed(4), currency);
    const grossAmount = unitPrice.multiply(quantity.toString());

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

      // Net of discount, excluding VAT, converted to the functional currency —
      // the amount that will later become cost of goods sold.
      const netAmount = grossAmount.subtract(discount);
      const netFunctional = netAmount.convertTo(settings.functionalCurrency, exchangeRate).round(4);
      const unitCost = netFunctional.divide(quantity.toString());

      const received = await receiveStock(tx, {
        tenantId: context.tenantId,
        branchId: document.branchId,
        warehouseId: document.warehouseId,
        productId: line.productId,
        date: postingDate.value,
        createdById: context.userId,
        quantity,
        unitCost,
        costingMethod: line.product.costingMethod ?? settings.costingMethod,
        movementType: 'IN',
        referenceType: 'DOCUMENT',
        referenceId: document.id,
        notes: `فاتورة مشتريات ${document.documentNumber}`,
        ...(line.batchNumber !== null ? { batchNumber: line.batchNumber } : {}),
        ...(line.serialNumber !== null ? { serialNumber: line.serialNumber } : {}),
        ...(line.expiryDate !== null
          ? { expiryDate: DateOnly.fromDate(line.expiryDate) }
          : {}),
      });

      if (!received.ok) return received;

      events.push(...received.value.events);
      receivedLines += 1;
    }

    lineFacts.push({
      productId: line.productId,
      ...(line.product.categoryId !== null ? { categoryId: line.product.categoryId } : {}),
      grossAmount,
      discount,
      taxAmount,
      cogsAmount: Money.zero(settings.functionalCurrency),
      isStockItem: line.product.isStockItem,
      description: line.descriptionAr ?? line.product.nameAr,
    });
  }

  const journalDraft = buildPurchaseInvoiceJournal(
    {
      documentId: document.id,
      documentNumber: document.documentNumber,
      counterpartyId: document.counterpartyId,
      date: postingDate.value,
      currency,
      exchangeRate,
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
  // `persistJournalEntry` publishes `finance.journal.posted` itself — adding it
  // here again would enqueue the same event id twice.

  await tx.document.update({
    where: { id: document.id },
    data: {
      status: 'POSTED',
      isPosted: true,
      postedAt: new Date(),
      postedById: context.userId,
    },
  });

  // A payable is a credit balance; the shared `balance` column is signed the
  // same way for both sides, so a purchase increments it exactly as a sale does.
  const totalFunctional = Money.of(document.total.toFixed(4), currency)
    .convertTo(settings.functionalCurrency, exchangeRate)
    .round(2);

  await tx.counterparty.update({
    where: { id: document.counterpartyId },
    data: { balance: { increment: fromMoney(totalFunctional) } },
  });

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
        receivedLines,
      },
    },
  );

  events.push(
    createDomainEvent(
      'procurement.invoice.posted',
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
        exchangeRate,
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
    receivedLines,
  });
}
