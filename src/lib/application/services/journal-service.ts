import type { ValidatedJournalEntry } from '@/lib/domain/accounting/journal-entry';
import { JournalEntryDraft } from '@/lib/domain/accounting/journal-entry';
import { createDomainEvent, type DomainEvent } from '@/lib/domain/shared/domain-event';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { recordAudit, type AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { fromMoney, fromRateString, toMoney } from '@/lib/infrastructure/db/decimal-mapper';
import { extractDatabaseErrorCode, type TransactionClient } from '@/lib/infrastructure/db/prisma';
import { eventBus } from '@/lib/infrastructure/events/event-bus';
import { allocateDocumentNumber } from './numbering-service';

/**
 * Persistence for the general ledger.
 *
 * A journal is always written as a DRAFT with its lines, then flipped to POSTED
 * in a second statement. That is not ceremony: the database trigger that
 * validates the balance and updates account balances fires on the status
 * transition, so the flip is the moment the entry becomes real, and it is
 * verified by PostgreSQL rather than only by the code that got us here.
 */

export interface PostJournalOptions {
  readonly audit: AuditContext;
  readonly createdById: string;
  /** Leave DRAFT for an entry that still needs review or approval. */
  readonly postImmediately?: boolean;
}

export interface PostedJournal {
  readonly journalId: string;
  readonly entryNumber: string;
  readonly date: Date;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly events: readonly DomainEvent[];
}

/**
 * Writes a validated entry to the ledger.
 *
 * The entry has already been proven balanced by `JournalEntryDraft.validate()`;
 * this function is responsible for numbering, fiscal-period resolution,
 * persistence, the audit row and the domain event.
 */
export async function persistJournalEntry(
  tx: TransactionClient,
  entry: ValidatedJournalEntry,
  options: PostJournalOptions,
): Promise<Result<PostedJournal, DomainError>> {
  const date = entry.date.toDate();
  const entryNumber = await allocateDocumentNumber(
    tx,
    entry.tenantId,
    'JOURNAL',
    entry.date.year,
  );

  const fiscalPeriod = await resolveFiscalPeriod(tx, entry.tenantId, entry.date);
  if (!fiscalPeriod.ok) return fiscalPeriod;

  const journal = await tx.journal.create({
    data: {
      tenantId: entry.tenantId,
      entryNumber,
      type: entry.type,
      status: 'DRAFT',
      date,
      branchId: entry.branchId ?? null,
      fiscalPeriodId: fiscalPeriod.value,
      descriptionAr: entry.descriptionAr,
      descriptionEn: entry.descriptionEn ?? null,
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      currency: entry.currency,
      exchangeRate: fromRateString(entry.exchangeRate),
      totalDebit: fromMoney(entry.totalDebit),
      totalCredit: fromMoney(entry.totalCredit),
      createdById: options.createdById,
    },
    select: { id: true },
  });

  await tx.journalLine.createMany({
    data: entry.lines.map((line, index) => ({
      tenantId: entry.tenantId,
      journalId: journal.id,
      journalDate: date,
      lineNumber: index + 1,
      accountId: line.accountId,
      debit: fromMoney(line.debit),
      credit: fromMoney(line.credit),
      foreignDebit: fromMoney(line.foreignDebit ?? Money.zero(entry.currency)),
      foreignCredit: fromMoney(line.foreignCredit ?? Money.zero(entry.currency)),
      description: line.description ?? null,
      costCenterId: line.costCenterId ?? null,
      projectId: line.projectId ?? null,
      counterpartyId: line.counterpartyId ?? null,
    })),
  });

  const events: DomainEvent[] = [];

  if (options.postImmediately !== false) {
    try {
      await tx.journal.update({
        where: { id_date: { id: journal.id, date } },
        data: {
          status: 'POSTED',
          postedById: options.createdById,
          postedAt: new Date(),
        },
      });
    } catch (error) {
      // The trigger refused. Translate its stable ERRCODE into the domain's
      // vocabulary rather than leaking a PostgreSQL message to the user.
      return err(translateLedgerError(error, entryNumber, entry));
    }

    events.push(
      createDomainEvent(
        'finance.journal.posted',
        journal.id,
        {
          journalId: journal.id,
          entryNumber,
          date: entry.date.toString(),
          type: entry.type,
          totalDebit: entry.totalDebit.toString(),
          totalCredit: entry.totalCredit.toString(),
          referenceType: entry.referenceType ?? null,
          referenceId: entry.referenceId ?? null,
        },
        {
          correlationId: options.audit.correlationId,
          tenantId: entry.tenantId,
          ...(options.audit.userId !== null ? { userId: options.audit.userId } : {}),
        },
      ),
    );
  }

  await recordAudit(
    tx,
    options.audit,
    options.postImmediately === false ? 'CREATE' : 'POST',
    { entityType: 'Journal', entityId: journal.id },
    {
      metadata: {
        entryNumber,
        type: entry.type,
        date: entry.date.toString(),
        totalDebit: entry.totalDebit.toString(),
        totalCredit: entry.totalCredit.toString(),
        lineCount: entry.lines.length,
        referenceType: entry.referenceType ?? null,
        referenceId: entry.referenceId ?? null,
      },
    },
  );

  // Enqueued here, inside the caller's transaction, so an entry that rolls back takes its
  // events with it. **Callers must not enqueue the returned `events` again** — the outbox
  // primary key is the event id, so a second insert fails the whole transaction. They are
  // returned for inspection, not as work still to be done. The journals route did exactly
  // that and every manual entry through it failed with a 500.
  await eventBus.enqueue(tx, events);

  return ok({
    journalId: journal.id,
    entryNumber,
    date,
    totalDebit: entry.totalDebit,
    totalCredit: entry.totalCredit,
    events,
  });
}

/**
 * Reverses a posted journal by generating and posting its mirror image.
 *
 * The original is never touched beyond being flagged, because a posted entry is
 * history. Reversal is the accounting profession's answer to "undo", and it
 * leaves both the mistake and its correction visible.
 */
export async function reverseJournalEntry(
  tx: TransactionClient,
  tenantId: string,
  journalId: string,
  journalDate: Date,
  reversalDate: DateOnly,
  options: PostJournalOptions & { reasonAr: string },
): Promise<Result<PostedJournal, DomainError>> {
  const original = await tx.journal.findUnique({
    where: { id_date: { id: journalId, date: journalDate } },
    include: { lines: true },
  });

  if (original === null || original.tenantId !== tenantId) {
    return err(DomainErrors.notFound('القيد المحاسبي', 'Journal entry', journalId));
  }

  if (original.status !== 'POSTED') {
    return err(
      DomainErrors.invalidTransition(
        original.status,
        'REVERSED',
        'القيد المحاسبي',
        'the journal entry',
      ),
    );
  }

  if (original.isReversed) {
    return err(
      DomainErrors.validation(
        `القيد ${original.entryNumber} معكوس بالفعل.`,
        `Journal ${original.entryNumber} has already been reversed.`,
      ),
    );
  }

  const draft = new JournalEntryDraft({
    tenantId,
    type: 'ADJUSTMENT',
    date: reversalDate,
    descriptionAr: `${options.reasonAr} - عكس القيد ${original.entryNumber}`,
    descriptionEn: `Reversal of journal ${original.entryNumber}`,
    branchId: original.branchId ?? undefined,
    referenceType: 'JOURNAL_REVERSAL',
    referenceId: original.id,
    currency: original.currency,
    exchangeRate: original.exchangeRate.toFixed(6),
    functionalCurrency: original.currency,
  });

  // Debits become credits and vice versa — generated, so it cannot be unbalanced.
  for (const line of original.lines) {
    const debit = toMoney(line.debit, original.currency);
    const credit = toMoney(line.credit, original.currency);
    const shared = {
      ...(line.description !== null ? { description: line.description } : {}),
      ...(line.costCenterId !== null ? { costCenterId: line.costCenterId } : {}),
      ...(line.projectId !== null ? { projectId: line.projectId } : {}),
      ...(line.counterpartyId !== null ? { counterpartyId: line.counterpartyId } : {}),
    };

    if (debit.isPositive) draft.credit(line.accountId, debit, shared);
    else draft.debit(line.accountId, credit, shared);
  }

  const validated = draft.validate();
  if (!validated.ok) return validated;

  const posted = await persistJournalEntry(tx, validated.value, options);
  if (!posted.ok) return posted;

  await tx.journal.update({
    where: { id_date: { id: journalId, date: journalDate } },
    data: { isReversed: true, status: 'REVERSED' },
  });

  await recordAudit(
    tx,
    options.audit,
    'REVERSE',
    { entityType: 'Journal', entityId: journalId },
    {
      metadata: {
        originalEntryNumber: original.entryNumber,
        reversalEntryNumber: posted.value.entryNumber,
        reason: options.reasonAr,
      },
    },
  );

  await eventBus.enqueue(tx, [
    createDomainEvent(
      'finance.journal.reversed',
      journalId,
      {
        journalId,
        entryNumber: original.entryNumber,
        reversalJournalId: posted.value.journalId,
        reversalEntryNumber: posted.value.entryNumber,
      },
      {
        correlationId: options.audit.correlationId,
        tenantId,
        ...(options.audit.userId !== null ? { userId: options.audit.userId } : {}),
      },
    ),
  ]);

  return posted;
}

/**
 * Finds the fiscal period covering `date`.
 *
 * A missing period is not fatal — an organisation may not have opened next year
 * yet — but a CLOSED one is, and the database enforces that independently.
 */
async function resolveFiscalPeriod(
  tx: TransactionClient,
  tenantId: string,
  date: DateOnly,
): Promise<Result<string | null, DomainError>> {
  const target = date.toDate();

  const period = await tx.fiscalPeriod.findFirst({
    where: {
      fiscalYear: { tenantId },
      startDate: { lte: target },
      endDate: { gte: target },
    },
    select: { id: true, status: true },
  });

  if (period === null) return ok(null);

  if (period.status === 'CLOSED') {
    return err(DomainErrors.fiscalPeriodClosed(date.toString()));
  }

  return ok(period.id);
}

/** Maps a trigger's ERRCODE to the equivalent domain refusal. */
function translateLedgerError(
  error: unknown,
  entryNumber: string,
  entry: ValidatedJournalEntry,
): DomainError {
  const code = extractDatabaseErrorCode(error);

  switch (code) {
    case 'ERP05':
      return DomainErrors.unbalancedEntry(
        entry.totalDebit.toFixed(2),
        entry.totalCredit.toFixed(2),
      );
    case 'ERP04':
      return DomainErrors.validation(
        `القيد ${entryNumber} يجب أن يحتوي على طرفين على الأقل.`,
        `Journal ${entryNumber} must have at least two lines.`,
      );
    case 'ERP06':
      return DomainErrors.validation(
        'أحد الحسابات المستخدمة تجميعي أو غير نشط.',
        'One of the accounts used is a summary account or is inactive.',
      );
    case 'ERP11':
      return DomainErrors.fiscalPeriodClosed(entry.date.toString());
    case 'ERP02':
      return DomainErrors.documentAlreadyPosted(entryNumber);
    default:
      throw error;
  }
}
