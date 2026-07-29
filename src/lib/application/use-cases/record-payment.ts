import type { DocumentStatus, PaymentMethod } from '@prisma/client';
import { buildPaymentJournal } from '@/lib/domain/accounting/posting-rules';
import { createDomainEvent, type DomainEvent } from '@/lib/domain/shared/domain-event';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import type { RequestContext } from '@/lib/infrastructure/auth/request-context';
import { checkSegregationOfDuties } from '@/lib/infrastructure/auth/segregation-of-duties';
import { fromMoney, fromRateString } from '@/lib/infrastructure/db/decimal-mapper';
import { withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';
import { allocateDocumentNumber } from '../services/numbering-service';
import { persistJournalEntry } from '../services/journal-service';
import { loadPostingContext, resolveExchangeRate } from '../services/tenant-context-loader';

/**
 * Recording a receipt or a payment, and settling it against open documents.
 *
 * The hard parts are all about the allocation:
 *   - a payment may settle several invoices, or part of one, or arrive as an
 *     unallocated advance;
 *   - it may never settle more than an invoice actually owes;
 *   - the invoice's status must follow its remaining balance automatically,
 *     because a human maintaining `PARTIAL_PAID` by hand will eventually not;
 *   - the counterparty's control balance must move by exactly the amount posted
 *     to the control account, or the sub-ledger stops reconciling.
 */

export interface PaymentAllocationInput {
  readonly documentId: string;
  /** Amount of this payment applied to that document, in the payment's currency. */
  readonly amount: string;
}

export interface RecordPaymentInput {
  readonly type: 'RECEIPT' | 'PAYMENT';
  readonly counterpartyId: string;
  readonly branchId: string;
  readonly paymentDate: string;
  readonly amount: string;
  readonly currency: string;
  readonly exchangeRate?: string;
  readonly method: PaymentMethod;
  /** Cash or bank GL account being moved. */
  readonly accountId: string;
  readonly checkNumber?: string;
  readonly checkDate?: string;
  readonly bankReference?: string;
  readonly notes?: string;
  readonly allocations: readonly PaymentAllocationInput[];
}

export interface RecordPaymentOutput {
  readonly paymentId: string;
  readonly voucherNumber: string;
  readonly journalId: string;
  readonly journalNumber: string;
  readonly allocatedAmount: string;
  readonly unallocatedAmount: string;
  readonly settledDocuments: readonly {
    documentId: string;
    documentNumber: string;
    status: DocumentStatus;
    outstanding: string;
  }[];
}

export async function recordPayment(
  context: RequestContext,
  input: RecordPaymentInput,
): Promise<Result<RecordPaymentOutput, DomainError>> {
  const permitted = context.permissions.require('treasury.payment', 'create');
  if (!permitted.ok) return permitted;

  return withTransaction(async (tx) => execute(tx, context, input));
}

async function execute(
  tx: TransactionClient,
  context: RequestContext,
  input: RecordPaymentInput,
): Promise<Result<RecordPaymentOutput, DomainError>> {
  const loaded = await loadPostingContext(tx, context.tenantId, input.branchId);
  if (!loaded.ok) return loaded;
  const { settings, posting } = loaded.value;

  const paymentDate = DateOnly.create(input.paymentDate);
  if (!paymentDate.ok) return paymentDate;

  let amount: Money;
  try {
    amount = Money.of(input.amount, input.currency);
  } catch {
    return err(DomainErrors.invalidFormat('المبلغ', 'amount', '1000.00', 'amount'));
  }

  if (!amount.isPositive) {
    return err(
      DomainErrors.validation(
        'مبلغ السند يجب أن يكون أكبر من صفر.',
        'The voucher amount must be greater than zero.',
        'amount',
      ),
    );
  }

  const rate = await resolveExchangeRate(
    tx,
    context.tenantId,
    input.currency,
    settings.functionalCurrency,
    paymentDate.value.toDate(),
    input.exchangeRate,
  );
  if (!rate.ok) return rate;

  const counterparty = await tx.counterparty.findUnique({
    where: { id: input.counterpartyId },
    select: { id: true, tenantId: true, code: true, nameAr: true, nameEn: true, balance: true },
  });

  if (counterparty === null || counterparty.tenantId !== context.tenantId) {
    return err(DomainErrors.notFound('الطرف', 'Counterparty', input.counterpartyId));
  }

  // ── Validate the allocations against what each document actually owes ──────
  const settlement = await validateAllocations(tx, context, input, settings.allowOverpayment);
  if (!settlement.ok) return settlement;

  const allocatedAmount = Money.sum(
    settlement.value.map((entry) => entry.amount),
    input.currency,
  );

  if (allocatedAmount.greaterThan(amount)) {
    return err(
      DomainErrors.validation(
        `إجمالي التخصيصات (${allocatedAmount.toFixed(2)}) يتجاوز مبلغ السند (${amount.toFixed(2)}).`,
        `Total allocations (${allocatedAmount.toFixed(2)}) exceed the voucher amount (${amount.toFixed(2)}).`,
        'allocations',
      ),
    );
  }

  const unallocatedAmount = amount.subtract(allocatedAmount);

  // ── Create the voucher ────────────────────────────────────────────────────
  const voucherNumber = await allocateDocumentNumber(
    tx,
    context.tenantId,
    input.type === 'RECEIPT' ? 'RECEIPT_VOUCHER' : 'PAYMENT_VOUCHER',
    paymentDate.value.year,
  );

  const checkDate =
    input.checkDate !== undefined && input.checkDate !== ''
      ? DateOnly.create(input.checkDate)
      : null;
  if (checkDate !== null && !checkDate.ok) return checkDate;

  const payment = await tx.payment.create({
    data: {
      tenantId: context.tenantId,
      voucherNumber,
      type: input.type,
      status: 'DRAFT',
      counterpartyId: input.counterpartyId,
      branchId: input.branchId,
      paymentDate: paymentDate.value.toDate(),
      amount: fromMoney(amount),
      unallocatedAmount: fromMoney(unallocatedAmount),
      currency: input.currency,
      exchangeRate: fromRateString(rate.value),
      method: input.method,
      accountId: input.accountId,
      checkNumber: input.checkNumber ?? null,
      checkDate: checkDate?.ok === true ? checkDate.value.toDate() : null,
      bankReference: input.bankReference ?? null,
      notes: input.notes ?? null,
      createdById: context.userId,
    },
    select: { id: true },
  });

  // ── Apply the allocations ─────────────────────────────────────────────────
  const events: DomainEvent[] = [];
  const settledDocuments: {
    documentId: string;
    documentNumber: string;
    status: DocumentStatus;
    outstanding: string;
  }[] = [];

  for (const entry of settlement.value) {
    await tx.paymentAllocation.create({
      data: {
        tenantId: context.tenantId,
        paymentId: payment.id,
        documentId: entry.documentId,
        amount: fromMoney(entry.amount),
      },
    });

    const newPaid = entry.alreadyPaid.add(entry.amount);
    const outstanding = entry.total.subtract(newPaid);

    // Status follows the arithmetic, never a human's recollection of it.
    const status: DocumentStatus = outstanding.isZero || outstanding.isNegative
      ? 'FULLY_PAID'
      : 'PARTIAL_PAID';

    await tx.document.update({
      where: { id: entry.documentId },
      data: { paidAmount: fromMoney(newPaid), status },
    });

    settledDocuments.push({
      documentId: entry.documentId,
      documentNumber: entry.documentNumber,
      status,
      outstanding: outstanding.toFixed(2),
    });

    events.push(
      createDomainEvent(
        'treasury.payment.allocated',
        payment.id,
        {
          paymentId: payment.id,
          documentId: entry.documentId,
          amount: entry.amount.toString(),
          documentStatus: status,
        },
        {
          correlationId: context.correlationId,
          tenantId: context.tenantId,
          userId: context.userId,
        },
      ),
    );
  }

  // ── Post the journal ──────────────────────────────────────────────────────
  const journalDraft = buildPaymentJournal(
    {
      paymentId: payment.id,
      voucherNumber,
      type: input.type,
      counterpartyId: input.counterpartyId,
      date: paymentDate.value,
      amount,
      currency: input.currency,
      exchangeRate: rate.value,
      cashAccountId: input.accountId,
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

  await tx.payment.update({
    where: { id: payment.id },
    data: { status: 'POSTED', postedAt: new Date(), postedById: context.userId },
  });

  // ── Move the counterparty's control balance ───────────────────────────────
  // A receipt reduces what a customer owes us; a payment reduces what we owe a
  // supplier. Both are a decrement of the same signed balance field.
  const amountFunctional = amount.convertTo(settings.functionalCurrency, rate.value).round(2);
  const previousBalance = Money.of(counterparty.balance.toFixed(4), settings.functionalCurrency);

  await tx.counterparty.update({
    where: { id: input.counterpartyId },
    data: { balance: { decrement: fromMoney(amountFunctional) } },
  });

  events.push(
    createDomainEvent(
      'counterparty.balance.changed',
      input.counterpartyId,
      {
        counterpartyId: input.counterpartyId,
        previousBalance: previousBalance.toString(),
        newBalance: previousBalance.subtract(amountFunctional).toString(),
        reason: `${input.type}:${voucherNumber}`,
      },
      { correlationId: context.correlationId, tenantId: context.tenantId, userId: context.userId },
    ),
    createDomainEvent(
      'treasury.payment.posted',
      payment.id,
      {
        paymentId: payment.id,
        voucherNumber,
        type: input.type,
        counterpartyId: input.counterpartyId,
        amount: amount.toString(),
        currency: input.currency,
        method: input.method,
      },
      { correlationId: context.correlationId, tenantId: context.tenantId, userId: context.userId },
    ),
  );

  await recordAudit(
    tx,
    audit,
    'POST',
    { entityType: 'Payment', entityId: payment.id },
    {
      metadata: {
        voucherNumber,
        type: input.type,
        counterpartyCode: counterparty.code,
        amount: amount.toString(),
        currency: input.currency,
        method: input.method,
        allocationCount: settlement.value.length,
        journalNumber: journal.value.entryNumber,
      },
    },
  );

  await eventBus.enqueue(tx, events);

  return ok({
    paymentId: payment.id,
    voucherNumber,
    journalId: journal.value.journalId,
    journalNumber: journal.value.entryNumber,
    allocatedAmount: allocatedAmount.toFixed(2),
    unallocatedAmount: unallocatedAmount.toFixed(2),
    settledDocuments,
  });
}

interface ValidatedAllocation {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly amount: Money;
  readonly total: Money;
  readonly alreadyPaid: Money;
}

/**
 * Checks every allocation against the target document.
 *
 * Rejects allocations to documents that are not posted, are void, belong to a
 * different counterparty, or are already settled. Overpayment is refused unless
 * the tenant has explicitly enabled it — and the database enforces the same rule
 * independently, so this check is the polite explanation rather than the defence.
 */
async function validateAllocations(
  tx: TransactionClient,
  context: RequestContext,
  input: RecordPaymentInput,
  allowOverpayment: boolean,
): Promise<Result<ValidatedAllocation[], DomainError>> {
  const results: ValidatedAllocation[] = [];
  const seen = new Set<string>();

  for (const allocation of input.allocations) {
    if (seen.has(allocation.documentId)) {
      return err(
        DomainErrors.validation(
          'لا يمكن تخصيص نفس المستند مرتين في السند الواحد.',
          'The same document cannot be allocated twice on one voucher.',
          'allocations',
        ),
      );
    }
    seen.add(allocation.documentId);

    const document = await tx.document.findUnique({
      where: { id: allocation.documentId },
      select: {
        id: true,
        tenantId: true,
        documentNumber: true,
        counterpartyId: true,
        currency: true,
        status: true,
        isPosted: true,
        total: true,
        paidAmount: true,
        createdById: true,
        approvedById: true,
        postedById: true,
      },
    });

    if (document === null || document.tenantId !== context.tenantId) {
      return err(DomainErrors.notFound('المستند', 'Document', allocation.documentId));
    }

    if (!document.isPosted) {
      return err(
        DomainErrors.validation(
          `المستند ${document.documentNumber} غير مُرحّل، ولا يمكن تحصيله.`,
          `Document ${document.documentNumber} is not posted and cannot be settled.`,
          'allocations',
        ),
      );
    }

    if (document.status === 'VOID') {
      return err(DomainErrors.documentVoided(document.documentNumber));
    }

    if (document.counterpartyId !== input.counterpartyId) {
      return err(
        DomainErrors.validation(
          `المستند ${document.documentNumber} يخص طرفاً آخر.`,
          `Document ${document.documentNumber} belongs to a different counterparty.`,
          'allocations',
        ),
      );
    }

    if (document.currency !== input.currency) {
      return err(DomainErrors.currencyMismatch(document.currency, input.currency));
    }

    // Whoever raised or approved the invoice must not be the one recording its
    // settlement — the classic three-way control.
    const sod = checkSegregationOfDuties({
      step: 'pay',
      userId: context.userId,
      actors: {
        createdById: document.createdById,
        approvedById: document.approvedById,
        postedById: document.postedById,
      },
      enforce: true,
      isSuperAdmin: context.isSuperAdmin,
    });
    if (!sod.ok) return sod;

    let amount: Money;
    try {
      amount = Money.of(allocation.amount, input.currency);
    } catch {
      return err(DomainErrors.invalidFormat('مبلغ التخصيص', 'allocation amount', '1000.00', 'allocations'));
    }

    if (!amount.isPositive) {
      return err(
        DomainErrors.validation(
          'مبلغ التخصيص يجب أن يكون أكبر من صفر.',
          'An allocation amount must be greater than zero.',
          'allocations',
        ),
      );
    }

    const total = Money.of(document.total.toFixed(4), document.currency);
    const alreadyPaid = Money.of(document.paidAmount.toFixed(4), document.currency);
    const outstanding = total.subtract(alreadyPaid);

    if (!outstanding.isPositive) {
      return err(
        DomainErrors.validation(
          `المستند ${document.documentNumber} مسدد بالكامل.`,
          `Document ${document.documentNumber} is already fully settled.`,
          'allocations',
        ),
      );
    }

    if (!allowOverpayment && amount.greaterThan(outstanding)) {
      return err(
        DomainErrors.overpaymentNotAllowed(
          amount.toFixed(2),
          outstanding.toFixed(2),
          document.documentNumber,
        ),
      );
    }

    results.push({
      documentId: document.id,
      documentNumber: document.documentNumber,
      amount,
      total,
      alreadyPaid,
    });
  }

  return ok(results);
}
