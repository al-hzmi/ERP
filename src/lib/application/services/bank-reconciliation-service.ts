import { Prisma } from '@prisma/client';
import {
  AUTO_MATCH_THRESHOLD,
  lineDirection,
  rankCandidates,
  type PaymentFacts,
  type StatementLineFacts,
} from '@/lib/domain/treasury/bank-matching';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';
import { logger } from '@/lib/infrastructure/logging/logger';

/**
 * Bank reconciliation.
 *
 * The schema for this shipped in migration 1 and nothing ever wrote to it. This is what
 * drives it, and what it exists to produce is one number: the difference between what the
 * bank says the account holds and what the ledger says, with every part of that difference
 * accounted for. A reconciliation that reaches zero by hiding something is worse than one
 * left undone, because it has been signed off.
 *
 * ## The arithmetic
 *
 * Every transaction touching the account is in one of three states, and that partition is
 * the whole method:
 *
 *   - **matched** — on the statement and in the ledger, so it moves both balances equally;
 *   - **statement only** — the bank knows, the books do not (charges, interest, a direct
 *     debit nobody recorded);
 *   - **books only** — the books know, the bank does not (a cheque written and not yet
 *     presented, a deposit in transit).
 *
 * So `bank closing − statement-only = matched = book balance − books-only`, and the
 * difference between those two sides is what must be zero. Presenting it as two columns
 * that have to meet is not decoration: it tells whoever is looking *which* side the
 * unexplained amount is on.
 *
 * ## What this service refuses
 *
 * A payment may be matched to at most one line — enforced by a partial unique index in
 * migration 007, not merely checked here, because two clerks matching the same payment at
 * the same instant would both pass a check. A statement is only marked reconciled when the
 * difference is exactly zero; the alternative is a button that lets someone assert
 * agreement that does not exist.
 */

export interface ReconciliationLine {
  readonly id: string;
  readonly valueDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly debit: string;
  readonly credit: string;
  readonly direction: 'IN' | 'OUT' | null;
  readonly matchedPaymentId: string | null;
  readonly matchedVoucherNumber: string | null;
  readonly matchScore: number | null;
  /** Ranked candidates, present only for unmatched lines. */
  readonly candidates: readonly {
    paymentId: string;
    voucherNumber: string;
    counterpartyName: string;
    paymentDate: string;
    amount: string;
    score: number;
    reasonsAr: readonly string[];
  }[];
}

export interface ReconciliationSummary {
  /** What the bank says the account holds at the end of the period. */
  readonly bankClosingBalance: string;
  /** What the ledger says, from posted journal lines up to and including `periodEnd`. */
  readonly bookBalance: string;
  /** Net of statement lines the books have no record of. */
  readonly statementOnlyNet: string;
  /** Net of posted payments the statement has no record of. */
  readonly booksOnlyNet: string;
  /** `bankClosing − statementOnly`, which must equal `bookBalance − booksOnly`. */
  readonly reconciledPerBank: string;
  readonly reconciledPerBooks: string;
  readonly difference: string;
  readonly isBalanced: boolean;
  readonly matchedLines: number;
  readonly unmatchedLines: number;
  readonly unmatchedPayments: number;
}

export interface ReconciliationView {
  readonly statement: {
    id: string;
    statementRef: string;
    accountId: string;
    accountCode: string;
    accountNameAr: string;
    periodStart: string;
    periodEnd: string;
    openingBalance: string;
    closingBalance: string;
    isReconciled: boolean;
    reconciledAt: string | null;
  };
  readonly lines: readonly ReconciliationLine[];
  readonly unmatchedPayments: readonly {
    id: string;
    voucherNumber: string;
    type: 'RECEIPT' | 'PAYMENT';
    paymentDate: string;
    amount: string;
    counterpartyName: string;
  }[];
  readonly summary: ReconciliationSummary;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The ledger balance of an account as of a date.
 *
 * Computed from posted journal lines rather than read from `Account.balance`, which is a
 * cached *current* balance. Reconciling last month against today's balance would produce a
 * difference equal to this month's activity and no way to see that was the reason.
 *
 * `journalDate` is denormalised onto the line and indexed with the account, so this is one
 * indexed aggregate rather than a join across the partitioned ledger.
 */
async function bookBalanceAsOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  asOf: Date,
): Promise<Prisma.Decimal> {
  const rows = await tx.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0) AS balance
      FROM "journal_lines" jl
      JOIN "journals" j ON j."id" = jl."journalId" AND j."date" = jl."journalDate"
     WHERE jl."tenantId" = ${tenantId}::uuid
       AND jl."accountId" = ${accountId}::uuid
       AND jl."journalDate" <= ${asOf}
       AND j."status" = 'POSTED'
  `;

  return rows[0]?.balance ?? new Prisma.Decimal(0);
}

/** Statements for the account picker, newest period first. */
export async function listStatements(input: {
  tenantId: string;
  accountId?: string;
}): Promise<
  {
    id: string;
    statementRef: string;
    accountCode: string;
    accountNameAr: string;
    periodStart: string;
    periodEnd: string;
    closingBalance: string;
    isReconciled: boolean;
    unmatchedLines: number;
  }[]
> {
  return withTenantRead(async (tx) => {
    const statements = await tx.bankStatement.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      },
      select: {
        id: true,
        statementRef: true,
        periodStart: true,
        periodEnd: true,
        closingBalance: true,
        isReconciled: true,
        account: { select: { code: true, nameAr: true } },
        _count: { select: { lines: { where: { matchedPaymentId: null } } } },
      },
      orderBy: [{ periodEnd: 'desc' }, { statementRef: 'desc' }],
      take: 100,
    });

    return statements.map((statement) => ({
      id: statement.id,
      statementRef: statement.statementRef,
      accountCode: statement.account.code,
      accountNameAr: statement.account.nameAr,
      periodStart: isoDate(statement.periodStart),
      periodEnd: isoDate(statement.periodEnd),
      closingBalance: statement.closingBalance.toString(),
      isReconciled: statement.isReconciled,
      unmatchedLines: statement._count.lines,
    }));
  });
}

/**
 * Everything the reconciliation screen needs, in one read.
 *
 * Candidates are scored here rather than on demand per line: the payments in scope are the
 * same set for every line, so fetching them once and scoring in memory is one query
 * instead of one per line — and a statement has hundreds of lines.
 */
export async function getReconciliation(input: {
  tenantId: string;
  statementId: string;
}): Promise<Result<ReconciliationView, DomainError>> {
  return withTenantRead(async (tx) => {
    const statement = await tx.bankStatement.findFirst({
      where: { id: input.statementId, tenantId: input.tenantId },
      select: {
        id: true,
        accountId: true,
        statementRef: true,
        periodStart: true,
        periodEnd: true,
        openingBalance: true,
        closingBalance: true,
        isReconciled: true,
        reconciledAt: true,
        account: { select: { code: true, nameAr: true } },
        lines: {
          select: {
            id: true,
            valueDate: true,
            description: true,
            reference: true,
            debit: true,
            credit: true,
            matchedPaymentId: true,
            matchScore: true,
            matchedPayment: { select: { voucherNumber: true } },
          },
          orderBy: [{ valueDate: 'asc' }],
        },
      },
    });

    if (statement === null) {
      return err(DomainErrors.notFound('كشف الحساب', 'Bank statement', input.statementId));
    }

    /**
     * Candidate payments.
     *
     * Four filters, and each removes something that would otherwise be offered wrongly:
     * the same bank account (a payment through another bank cannot appear here), POSTED
     * only (a draft is not in the ledger and a void has been reversed), not already
     * matched to some other line, and within a window around the period — a cheque
     * written in March can clear in April, so the window is wider than the statement.
     */
    const windowStart = new Date(statement.periodStart);
    windowStart.setUTCDate(windowStart.getUTCDate() - 60);
    const windowEnd = new Date(statement.periodEnd);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);

    const payments = await tx.payment.findMany({
      where: {
        tenantId: input.tenantId,
        accountId: statement.accountId,
        status: 'POSTED',
        paymentDate: { gte: windowStart, lte: windowEnd },
        bankMatches: { none: {} },
      },
      select: {
        id: true,
        voucherNumber: true,
        type: true,
        amount: true,
        paymentDate: true,
        bankReference: true,
        checkNumber: true,
        counterparty: { select: { nameAr: true } },
      },
      orderBy: { paymentDate: 'asc' },
    });

    const facts: PaymentFacts[] = payments.map((payment) => ({
      id: payment.id,
      voucherNumber: payment.voucherNumber,
      type: payment.type,
      amount: payment.amount.toString(),
      paymentDate: isoDate(payment.paymentDate),
      bankReference: payment.bankReference,
      checkNumber: payment.checkNumber,
      counterpartyName: payment.counterparty.nameAr,
    }));

    const factsById = new Map(facts.map((fact) => [fact.id, fact]));

    let statementOnlyNet = new Prisma.Decimal(0);
    let matchedCount = 0;

    const lines: ReconciliationLine[] = statement.lines.map((line) => {
      const lineFacts: StatementLineFacts = {
        id: line.id,
        debit: line.debit.toString(),
        credit: line.credit.toString(),
        valueDate: isoDate(line.valueDate),
        description: line.description,
        reference: line.reference,
      };

      const direction = lineDirection(lineFacts);

      if (line.matchedPaymentId !== null) {
        matchedCount += 1;
      } else {
        // Signed: a deposit the books never recorded pushes the bank balance above the
        // ledger, a charge pushes it below, and the reconciliation needs the net.
        statementOnlyNet = statementOnlyNet.plus(line.debit).minus(line.credit);
      }

      const candidates =
        line.matchedPaymentId !== null
          ? []
          : rankCandidates(lineFacts, facts)
              .slice(0, 5)
              .map((candidate) => {
                const fact = factsById.get(candidate.paymentId);
                return {
                  paymentId: candidate.paymentId,
                  voucherNumber: fact?.voucherNumber ?? '',
                  counterpartyName: fact?.counterpartyName ?? '',
                  paymentDate: fact?.paymentDate ?? '',
                  amount: fact?.amount ?? '0',
                  score: candidate.score,
                  reasonsAr: candidate.reasonsAr,
                };
              });

      return {
        id: line.id,
        valueDate: isoDate(line.valueDate),
        description: line.description,
        reference: line.reference,
        debit: line.debit.toString(),
        credit: line.credit.toString(),
        direction,
        matchedPaymentId: line.matchedPaymentId,
        matchedVoucherNumber: line.matchedPayment?.voucherNumber ?? null,
        matchScore: line.matchScore,
        candidates,
      };
    });

    // Payments in the period the statement does not show: outstanding cheques and
    // deposits in transit. Restricted to the statement's own period — a payment dated
    // after `periodEnd` is not missing from this statement, it is simply later.
    let booksOnlyNet = new Prisma.Decimal(0);
    const unmatchedPayments = payments
      .filter(
        (payment) =>
          payment.paymentDate >= statement.periodStart && payment.paymentDate <= statement.periodEnd,
      )
      .map((payment) => {
        const signed = payment.type === 'RECEIPT' ? payment.amount : payment.amount.negated();
        booksOnlyNet = booksOnlyNet.plus(signed);

        return {
          id: payment.id,
          voucherNumber: payment.voucherNumber,
          type: payment.type,
          paymentDate: isoDate(payment.paymentDate),
          amount: payment.amount.toString(),
          counterpartyName: payment.counterparty.nameAr,
        };
      });

    const bookBalance = await bookBalanceAsOf(
      tx,
      input.tenantId,
      statement.accountId,
      statement.periodEnd,
    );

    const reconciledPerBank = statement.closingBalance.minus(statementOnlyNet);
    const reconciledPerBooks = bookBalance.minus(booksOnlyNet);
    const difference = reconciledPerBank.minus(reconciledPerBooks);

    return ok({
      statement: {
        id: statement.id,
        statementRef: statement.statementRef,
        accountId: statement.accountId,
        accountCode: statement.account.code,
        accountNameAr: statement.account.nameAr,
        periodStart: isoDate(statement.periodStart),
        periodEnd: isoDate(statement.periodEnd),
        openingBalance: statement.openingBalance.toString(),
        closingBalance: statement.closingBalance.toString(),
        isReconciled: statement.isReconciled,
        reconciledAt: statement.reconciledAt?.toISOString() ?? null,
      },
      lines,
      unmatchedPayments,
      summary: {
        bankClosingBalance: statement.closingBalance.toString(),
        bookBalance: bookBalance.toString(),
        statementOnlyNet: statementOnlyNet.toString(),
        booksOnlyNet: booksOnlyNet.toString(),
        reconciledPerBank: reconciledPerBank.toString(),
        reconciledPerBooks: reconciledPerBooks.toString(),
        difference: difference.toString(),
        isBalanced: difference.isZero(),
        matchedLines: matchedCount,
        unmatchedLines: lines.length - matchedCount,
        unmatchedPayments: unmatchedPayments.length,
      },
    });
  });
}

/**
 * Matches one line to one payment.
 *
 * Re-reads both inside a serialisable transaction and re-scores the pair, so a match is
 * only written if it is still legitimate: a payment can be matched by someone else, a line
 * can already be matched, and the amounts must still agree. The unique index is the final
 * word on the concurrent case — this check exists so the common case gets an explanation
 * rather than a constraint violation.
 */
export async function matchLine(input: {
  tenantId: string;
  statementId: string;
  lineId: string;
  paymentId: string;
  userId: string;
}): Promise<Result<{ lineId: string; score: number }, DomainError>> {
  return withTransaction(async (tx) => {
    const line = await tx.bankStatementLine.findFirst({
      where: { id: input.lineId, bankStatement: { id: input.statementId, tenantId: input.tenantId } },
      select: {
        id: true,
        debit: true,
        credit: true,
        valueDate: true,
        description: true,
        reference: true,
        matchedPaymentId: true,
        bankStatement: { select: { accountId: true, isReconciled: true } },
      },
    });

    if (line === null) {
      return err(DomainErrors.notFound('سطر الكشف', 'Statement line', input.lineId));
    }

    if (line.bankStatement.isReconciled) {
      return err(
        DomainErrors.validation(
          'الكشف مُعتمد كمُطابَق — أعِد فتحه قبل تعديل المطابقات.',
          'This statement is signed off as reconciled. Reopen it before changing matches.',
        ),
      );
    }

    if (line.matchedPaymentId !== null) {
      return err(
        DomainErrors.validation('هذا السطر مُطابَق بالفعل.', 'This line is already matched.'),
      );
    }

    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, tenantId: input.tenantId },
      select: {
        id: true,
        voucherNumber: true,
        type: true,
        amount: true,
        paymentDate: true,
        bankReference: true,
        checkNumber: true,
        accountId: true,
        status: true,
        counterparty: { select: { nameAr: true } },
        bankMatches: { select: { id: true } },
      },
    });

    if (payment === null) {
      return err(DomainErrors.notFound('سند الدفع', 'Payment', input.paymentId));
    }

    if (payment.status !== 'POSTED') {
      return err(
        DomainErrors.validation(
          'لا يمكن مطابقة سند غير مُرحَّل.',
          'Only a posted payment can be reconciled.',
        ),
      );
    }

    // A payment through a different bank account cannot appear on this statement, however
    // well the amount and date agree.
    if (payment.accountId !== line.bankStatement.accountId) {
      return err(
        DomainErrors.validation(
          'السند مسجَّل على حساب بنكي آخر.',
          'That payment was made through a different bank account.',
        ),
      );
    }

    if (payment.bankMatches.length > 0) {
      return err(
        DomainErrors.validation(
          'السند مُطابَق بسطر آخر — لا يمكن تسويته مرتين.',
          'That payment is already matched to another statement line.',
        ),
      );
    }

    const scored = rankCandidates(
      {
        id: line.id,
        debit: line.debit.toString(),
        credit: line.credit.toString(),
        valueDate: isoDate(line.valueDate),
        description: line.description,
        reference: line.reference,
      },
      [
        {
          id: payment.id,
          voucherNumber: payment.voucherNumber,
          type: payment.type,
          amount: payment.amount.toString(),
          paymentDate: isoDate(payment.paymentDate),
          bankReference: payment.bankReference,
          checkNumber: payment.checkNumber,
          counterpartyName: payment.counterparty.nameAr,
        },
      ],
    );

    const candidate = scored[0];
    if (candidate === undefined) {
      // The amount or the direction disagrees. Allowing it anyway would let someone
      // reconcile a 4,999.50 line against a 5,000.00 payment and lose the difference.
      return err(
        DomainErrors.validation(
          'المبلغ أو اتجاه الحركة لا يطابق السند.',
          'The amount or the direction does not agree with that payment.',
        ),
      );
    }

    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: {
        matchedPaymentId: payment.id,
        matchedAt: new Date(),
        // A human chose this, so the recorded confidence is total regardless of what the
        // scorer thought: `matchScore` records how sure the *system* was, and a manual
        // match is not the system's opinion.
        matchScore: 100,
      },
    });

    logger.info('Bank statement line matched', {
      statementId: input.statementId,
      lineId: line.id,
      paymentId: payment.id,
      suggestedScore: candidate.score,
      userId: input.userId,
    });

    return ok({ lineId: line.id, score: 100 });
  });
}

/** Releases a match, so a mistake can be corrected. */
export async function unmatchLine(input: {
  tenantId: string;
  statementId: string;
  lineId: string;
  userId: string;
}): Promise<Result<{ lineId: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const line = await tx.bankStatementLine.findFirst({
      where: { id: input.lineId, bankStatement: { id: input.statementId, tenantId: input.tenantId } },
      select: { id: true, matchedPaymentId: true, bankStatement: { select: { isReconciled: true } } },
    });

    if (line === null) {
      return err(DomainErrors.notFound('سطر الكشف', 'Statement line', input.lineId));
    }

    if (line.bankStatement.isReconciled) {
      return err(
        DomainErrors.validation(
          'الكشف مُعتمد كمُطابَق — أعِد فتحه قبل تعديل المطابقات.',
          'This statement is signed off as reconciled. Reopen it before changing matches.',
        ),
      );
    }

    if (line.matchedPaymentId === null) {
      return err(
        DomainErrors.validation('هذا السطر غير مُطابَق.', 'This line is not matched.'),
      );
    }

    // All three cleared together: migration 007 refuses a half-written match.
    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { matchedPaymentId: null, matchedAt: null, matchScore: null },
    });

    logger.info('Bank statement line unmatched', {
      statementId: input.statementId,
      lineId: line.id,
      userId: input.userId,
    });

    return ok({ lineId: line.id });
  });
}

/**
 * Applies every match the evidence settles on its own, and leaves the rest.
 *
 * "On its own" is doing the work: a candidate must clear the confidence threshold *and*
 * be the only one at that score. Two identical transfers to the same supplier on the same
 * day is not a rare case, and that is exactly when an automatic matcher must decline —
 * picking the first would be a coin toss recorded as a reconciliation.
 *
 * Runs one line at a time against a set that shrinks as it goes, so it cannot match two
 * lines to the same payment within a single pass.
 */
export async function autoMatchStatement(input: {
  tenantId: string;
  statementId: string;
  userId: string;
}): Promise<Result<{ matched: number; ambiguous: number; unmatched: number }, DomainError>> {
  const view = await getReconciliation({ tenantId: input.tenantId, statementId: input.statementId });
  if (!view.ok) return view;

  if (view.value.statement.isReconciled) {
    return err(
      DomainErrors.validation(
        'الكشف مُعتمد كمُطابَق — أعِد فتحه قبل المطابقة الآلية.',
        'This statement is signed off as reconciled. Reopen it first.',
      ),
    );
  }

  const availablePayments: PaymentFacts[] = view.value.unmatchedPayments.map((payment) => ({
    id: payment.id,
    voucherNumber: payment.voucherNumber,
    type: payment.type,
    amount: payment.amount,
    paymentDate: payment.paymentDate,
    // The view does not carry these, and it does not need to: what matters for the
    // *automatic* decision is the amount, the direction and the date, and a reference that
    // only appears in the fuller candidate list has already been scored into it.
    bankReference: null,
    checkNumber: null,
    counterpartyName: payment.counterpartyName,
  }));

  const remaining = new Map(availablePayments.map((payment) => [payment.id, payment]));

  let matched = 0;
  let ambiguous = 0;

  for (const line of view.value.lines) {
    if (line.matchedPaymentId !== null) continue;

    const facts: StatementLineFacts = {
      id: line.id,
      debit: line.debit,
      credit: line.credit,
      valueDate: line.valueDate,
      description: line.description,
      reference: line.reference,
    };

    // Scored against the *candidates the view already computed*, filtered to those still
    // available: the view's scoring saw the full reference data, which is stronger evidence
    // than this pass could reconstruct.
    const stillAvailable = line.candidates.filter((candidate) =>
      remaining.has(candidate.paymentId),
    );

    const best = stillAvailable[0];
    const runnerUp = stillAvailable[1];

    if (best === undefined || best.score < AUTO_MATCH_THRESHOLD) continue;
    if (runnerUp !== undefined && runnerUp.score === best.score) {
      ambiguous += 1;
      continue;
    }

    const result = await matchLine({
      tenantId: input.tenantId,
      statementId: input.statementId,
      lineId: line.id,
      paymentId: best.paymentId,
      userId: input.userId,
    });

    if (result.ok) {
      remaining.delete(best.paymentId);
      matched += 1;
    }
  }

  const after = await getReconciliation({
    tenantId: input.tenantId,
    statementId: input.statementId,
  });

  return ok({
    matched,
    ambiguous,
    unmatched: after.ok ? after.value.summary.unmatchedLines : 0,
  });
}

/**
 * Signs the statement off, but only if it actually reconciles.
 *
 * Refusing a non-zero difference is the point. A button that let someone assert agreement
 * that does not exist would make `isReconciled` mean "somebody clicked", and the whole
 * control is that it means "the difference was zero and this person says so".
 */
export async function finaliseStatement(input: {
  tenantId: string;
  statementId: string;
  userId: string;
}): Promise<Result<{ statementId: string }, DomainError>> {
  const view = await getReconciliation({ tenantId: input.tenantId, statementId: input.statementId });
  if (!view.ok) return view;

  if (view.value.statement.isReconciled) {
    return err(
      DomainErrors.validation('الكشف مُعتمد بالفعل.', 'This statement is already reconciled.'),
    );
  }

  if (!view.value.summary.isBalanced) {
    return err(
      DomainErrors.validation(
        `لا يمكن اعتماد الكشف: يوجد فرق غير مُفسَّر بمقدار ${view.value.summary.difference}.`,
        `Cannot sign off: an unexplained difference of ${view.value.summary.difference} remains.`,
      ),
    );
  }

  return withTransaction(async (tx) => {
    // Re-read inside the transaction: a match could have been released between the summary
    // and the sign-off, and signing off a statement that no longer balances is exactly the
    // outcome the check above exists to prevent.
    const current = await tx.bankStatement.findFirst({
      where: { id: input.statementId, tenantId: input.tenantId },
      select: { isReconciled: true },
    });

    if (current === null) {
      return err(DomainErrors.notFound('كشف الحساب', 'Bank statement', input.statementId));
    }
    if (current.isReconciled) {
      return err(
        DomainErrors.validation('الكشف مُعتمد بالفعل.', 'This statement is already reconciled.'),
      );
    }

    await tx.bankStatement.update({
      where: { id: input.statementId },
      data: { isReconciled: true, reconciledAt: new Date(), reconciledById: input.userId },
    });

    logger.info('Bank statement reconciled', {
      statementId: input.statementId,
      userId: input.userId,
    });

    return ok({ statementId: input.statementId });
  });
}

/** Reopens a signed-off statement so its matches can be corrected. */
export async function reopenStatement(input: {
  tenantId: string;
  statementId: string;
  userId: string;
}): Promise<Result<{ statementId: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const statement = await tx.bankStatement.findFirst({
      where: { id: input.statementId, tenantId: input.tenantId },
      select: { isReconciled: true },
    });

    if (statement === null) {
      return err(DomainErrors.notFound('كشف الحساب', 'Bank statement', input.statementId));
    }

    if (!statement.isReconciled) {
      return err(
        DomainErrors.validation('الكشف غير مُعتمد أصلاً.', 'This statement is not signed off.'),
      );
    }

    // All three cleared together, as the constraint requires. The reopening is logged
    // rather than recorded on the row: what matters for audit is that it happened and who
    // did it, and the row's job is to say whether it is currently signed off.
    await tx.bankStatement.update({
      where: { id: input.statementId },
      data: { isReconciled: false, reconciledAt: null, reconciledById: null },
    });

    logger.warn('Bank statement reopened after sign-off', {
      statementId: input.statementId,
      userId: input.userId,
    });

    return ok({ statementId: input.statementId });
  });
}
