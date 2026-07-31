import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import {
  ageOpenItems,
  exposurePercent,
  fromScaled,
  overdueDays,
  type AgingProfile,
  type OpenItem,
} from '@/lib/domain/collections/aging';
import { toScaled } from '@/lib/domain/approvals/rule-evaluator';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import type { TransactionClient } from '@/lib/infrastructure/db/prisma';
import { prisma, withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * Collections: who owes what, for how long, and whether to keep selling to them.
 *
 * ## Two paths, one definition of "overdue"
 *
 * The dashboard buckets every customer in SQL, because a report over four hundred accounts
 * must not ship four hundred sets of invoices to Node. The credit-hold path ages **one**
 * customer's open items through `domain/collections/aging.ts`, in `bigint`, because that answer
 * gates a sale and has to be exact and explicable line by line.
 *
 * Two implementations of one rule is the drift risk this codebase has been bitten by before
 * (see `search-normalize`). So the SQL mirrors `overdueDays()` exactly —
 * `asOf - dueDate - graceDays` — and `tests/integration/collections.test.ts` runs both over the
 * same data and asserts they agree. Changing one without the other fails there.
 *
 * ## Grace comes from the profile, and the default is not zero-if-missing
 *
 * A customer with no `CustomerCreditProfile` row gets the tenant default (0 grace, hold at 60
 * days) rather than being treated as ungoverned. Most customers will never have a profile, and
 * "no row" meaning "no credit control" would leave the feature switched off for exactly the
 * accounts nobody has looked at.
 */

/** What a customer with no profile row gets. Also the shape a new profile is created with. */
export const DEFAULT_CREDIT_TERMS = { graceDays: 0, holdAfterDays: 60 } as const;

export interface CollectionsBuckets {
  readonly current: string;
  readonly days1to30: string;
  readonly days31to60: string;
  readonly days61to90: string;
  readonly over90: string;
  readonly total: string;
  readonly overdue: string;
}

export interface DelinquentCustomer extends CollectionsBuckets {
  readonly counterpartyId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly phone: string | null;
  readonly invoiceCount: number;
  readonly oldestOverdueDays: number;
  readonly graceDays: number;
  readonly holdAfterDays: number;
  readonly isBlocked: boolean;
  readonly blockReason: string | null;
  /** `null` when no credit limit is set — not 0, which would read as the safest account. */
  readonly exposurePercent: string | null;
  readonly creditLimit: string;
  /** True when this customer would have a new sales order held today. */
  readonly wouldHold: boolean;
}

export interface CollectionsOverview {
  readonly asOf: string;
  readonly totals: CollectionsBuckets;
  readonly customers: readonly DelinquentCustomer[];
  readonly customerCount: number;
  readonly delinquentCount: number;
  readonly blockedCount: number;
}

interface RawAgingRow {
  counterpartyId: string;
  code: string;
  nameAr: string;
  phone: string | null;
  creditLimit: string;
  graceDays: number;
  holdAfterDays: number;
  isBlocked: boolean;
  blockReason: string | null;
  invoiceCount: bigint;
  oldestOverdueDays: number | null;
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  days61to90plus?: string;
  over90: string;
  total: string;
}

/**
 * The whole receivable book, aged, one row per customer.
 *
 * The `overdueDays` expression here is the SQL twin of `overdueDays()` in the domain module —
 * `asOf - dueDate - graceDays`. They are asserted equal in the integration suite.
 *
 * Only `SALES_INVOICE` and `SALES_CREDIT_NOTE` are considered, and drafts and voids are
 * excluded, matching every other receivable figure in the system. A quotation is not money
 * anybody owes.
 */
export async function getCollectionsOverview(input: {
  tenantId: string;
  asOf: Date;
  /** Show only customers with something past due. The dashboard's default. */
  overdueOnly?: boolean;
}): Promise<CollectionsOverview> {
  const rows = await prisma.$queryRaw<RawAgingRow[]>`
    WITH terms AS (
      SELECT c."id"          AS "counterpartyId",
             c."code",
             c."nameAr",
             c."phone",
             c."creditLimit",
             COALESCE(p."graceDays", ${DEFAULT_CREDIT_TERMS.graceDays})         AS "graceDays",
             COALESCE(p."holdAfterDays", ${DEFAULT_CREDIT_TERMS.holdAfterDays}) AS "holdAfterDays",
             COALESCE(p."isBlocked", false)                                     AS "isBlocked",
             p."blockReason"
        FROM "counterparties" c
        LEFT JOIN "customer_credit_profiles" p ON p."counterpartyId" = c."id"
       WHERE c."tenantId" = ${input.tenantId}::uuid
         AND c."type" IN ('CUSTOMER', 'BOTH')
    ),
    open_items AS (
      SELECT d."counterpartyId",
             -- The SQL twin of overdueDays(): raw age less the customer's grace. A separate
             -- rule here and in the domain module is the drift this arrangement guards.
             (${input.asOf}::date - d."dueDate" - t."graceDays")::int AS "overdueDays",
             CASE WHEN d."type"::text = 'SALES_CREDIT_NOTE'
                  THEN -(d."total" - d."paidAmount")
                  ELSE   d."total" - d."paidAmount"
             END AS outstanding
        FROM "documents" d
        JOIN terms t ON t."counterpartyId" = d."counterpartyId"
       WHERE d."tenantId" = ${input.tenantId}::uuid
         AND d."type"::text IN ('SALES_INVOICE', 'SALES_CREDIT_NOTE')
         AND d."status"::text NOT IN ('DRAFT', 'PENDING_APPROVAL', 'VOID')
         AND d."total" > d."paidAmount"
    )
    SELECT t."counterpartyId",
           t."code",
           t."nameAr",
           t."phone",
           t."creditLimit"::text  AS "creditLimit",
           t."graceDays",
           t."holdAfterDays",
           t."isBlocked",
           t."blockReason",
           COUNT(o.*)             AS "invoiceCount",
           MAX(CASE WHEN o."overdueDays" > 0 AND o.outstanding > 0
                    THEN o."overdueDays" END)::int AS "oldestOverdueDays",
           COALESCE(SUM(CASE WHEN o."overdueDays" <= 0                          THEN o.outstanding ELSE 0 END), 0)::text AS "current",
           COALESCE(SUM(CASE WHEN o."overdueDays" BETWEEN 1  AND 30             THEN o.outstanding ELSE 0 END), 0)::text AS "days1to30",
           COALESCE(SUM(CASE WHEN o."overdueDays" BETWEEN 31 AND 60             THEN o.outstanding ELSE 0 END), 0)::text AS "days31to60",
           COALESCE(SUM(CASE WHEN o."overdueDays" BETWEEN 61 AND 90             THEN o.outstanding ELSE 0 END), 0)::text AS "days61to90",
           COALESCE(SUM(CASE WHEN o."overdueDays" > 90                          THEN o.outstanding ELSE 0 END), 0)::text AS "over90",
           COALESCE(SUM(o.outstanding), 0)::text                                                                        AS "total"
      FROM terms t
      LEFT JOIN open_items o ON o."counterpartyId" = t."counterpartyId"
     GROUP BY t."counterpartyId", t."code", t."nameAr", t."phone", t."creditLimit",
              t."graceDays", t."holdAfterDays", t."isBlocked", t."blockReason"
    HAVING COALESCE(SUM(o.outstanding), 0) <> 0 OR COALESCE(bool_or(t."isBlocked"), false)
     ORDER BY COALESCE(SUM(CASE WHEN o."overdueDays" > 90 THEN o.outstanding ELSE 0 END), 0) DESC,
              COALESCE(SUM(o.outstanding), 0) DESC
  `;

  const customers: DelinquentCustomer[] = rows.map((row) => {
    const overdue =
      (toScaled(row.days1to30) ?? 0n) +
      (toScaled(row.days31to60) ?? 0n) +
      (toScaled(row.days61to90) ?? 0n) +
      (toScaled(row.over90) ?? 0n);

    const total = toScaled(row.total) ?? 0n;
    const limit = toScaled(row.creditLimit) ?? 0n;
    const oldest = row.oldestOverdueDays ?? 0;

    return {
      counterpartyId: row.counterpartyId,
      code: row.code,
      nameAr: row.nameAr,
      phone: row.phone,
      current: row.current,
      days1to30: row.days1to30,
      days31to60: row.days31to60,
      days61to90: row.days61to90,
      over90: row.over90,
      total: row.total,
      overdue: fromScaled(overdue),
      invoiceCount: Number(row.invoiceCount),
      oldestOverdueDays: oldest,
      graceDays: row.graceDays,
      holdAfterDays: row.holdAfterDays,
      isBlocked: row.isBlocked,
      blockReason: row.blockReason,
      exposurePercent: exposurePercent(total, limit),
      creditLimit: row.creditLimit,
      // The same test the credit gate applies, shown before anyone tries to sell.
      wouldHold: row.isBlocked || oldest >= row.holdAfterDays,
    };
  });

  const shown = input.overdueOnly === true
    ? customers.filter((customer) => customer.oldestOverdueDays > 0 || customer.isBlocked)
    : customers;

  const sum = (pick: (customer: DelinquentCustomer) => string): string =>
    fromScaled(customers.reduce((running, customer) => running + (toScaled(pick(customer)) ?? 0n), 0n));

  return {
    asOf: input.asOf.toISOString().slice(0, 10),
    // Totals are over *every* customer with a balance, not only the filtered rows: "money in
    // the market" is the whole book, and a total that moved when somebody ticked a filter
    // would be a different number with the same label.
    totals: {
      current: sum((c) => c.current),
      days1to30: sum((c) => c.days1to30),
      days31to60: sum((c) => c.days31to60),
      days61to90: sum((c) => c.days61to90),
      over90: sum((c) => c.over90),
      total: sum((c) => c.total),
      overdue: sum((c) => c.overdue),
    },
    customers: shown,
    customerCount: customers.length,
    delinquentCount: customers.filter((customer) => customer.oldestOverdueDays > 0).length,
    blockedCount: customers.filter((customer) => customer.wouldHold).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The credit facts a rule asks about
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditFacts {
  readonly OVERDUE_DAYS: string;
  readonly OVERDUE_AMOUNT: string;
  readonly CREDIT_EXPOSURE_PERCENT: string;
}

/**
 * One customer's credit position, aged in `bigint` through the domain module.
 *
 * Runs inside the caller's transaction so the numbers a rule fires on are the numbers as at
 * the instant of the decision — a payment landing between the read and the write must not be
 * able to change whether an order was held.
 *
 * A blocked customer returns an `OVERDUE_DAYS` of `holdAfterDays` so that any hold rule fires
 * regardless of the arithmetic. That is the manual override doing its job: a customer in
 * dispute is stopped even if they happen to owe nothing today.
 */
export async function getCreditFacts(
  tx: TransactionClient,
  input: { tenantId: string; counterpartyId: string; asOf: Date },
): Promise<{ facts: CreditFacts; profile: AgingProfile; isBlocked: boolean }> {
  const [counterparty, invoices] = await Promise.all([
    tx.counterparty.findFirst({
      where: { id: input.counterpartyId, tenantId: input.tenantId },
      select: { creditLimit: true, creditProfile: { select: { graceDays: true, isBlocked: true, holdAfterDays: true } } },
    }),
    tx.document.findMany({
      where: {
        tenantId: input.tenantId,
        counterpartyId: input.counterpartyId,
        type: { in: ['SALES_INVOICE', 'SALES_CREDIT_NOTE'] },
        status: { notIn: ['DRAFT', 'PENDING_APPROVAL', 'VOID'] },
      },
      select: { type: true, dueDate: true, total: true, paidAmount: true },
    }),
  ]);

  const graceDays = counterparty?.creditProfile?.graceDays ?? DEFAULT_CREDIT_TERMS.graceDays;
  const holdAfterDays =
    counterparty?.creditProfile?.holdAfterDays ?? DEFAULT_CREDIT_TERMS.holdAfterDays;
  const isBlocked = counterparty?.creditProfile?.isBlocked ?? false;

  const items: OpenItem[] = invoices
    .filter((invoice) => invoice.total.greaterThan(invoice.paidAmount))
    .map((invoice) => {
      const outstanding = invoice.total.minus(invoice.paidAmount);
      return {
        overdueDays: overdueDays(input.asOf, invoice.dueDate, graceDays),
        outstanding:
          invoice.type === 'SALES_CREDIT_NOTE'
            ? outstanding.negated().toString()
            : outstanding.toString(),
      };
    });

  const profile = ageOpenItems(items);
  const limit = toScaled(counterparty?.creditLimit.toString() ?? '0') ?? 0n;

  return {
    facts: {
      // A block reports as being at the hold threshold, so any "overdue over N days" rule
      // catches it. The override is meant to stop sales, not to be argued with by arithmetic.
      OVERDUE_DAYS: isBlocked
        ? String(Math.max(holdAfterDays, profile.oldestOverdueDays))
        : String(profile.oldestOverdueDays),
      OVERDUE_AMOUNT: fromScaled(profile.overdue),
      // No limit means no ratio. Zero would read as the safest account on the book, so an
      // unlimited customer reports 0 and any exposure rule simply does not fire for them —
      // which is what "no limit" means.
      CREDIT_EXPOSURE_PERCENT: exposurePercent(profile.total, limit) ?? '0',
    },
    profile,
    isBlocked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Statement of account
// ─────────────────────────────────────────────────────────────────────────────

export interface StatementLine {
  readonly date: string;
  readonly reference: string;
  readonly kindAr: string;
  readonly debit: string;
  readonly credit: string;
  readonly balance: string;
  readonly dueDate: string | null;
  readonly overdueDays: number | null;
}

export interface Statement {
  readonly counterpartyId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly asOf: string;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly lines: readonly StatementLine[];
  readonly aging: CollectionsBuckets;
  readonly oldestOverdueDays: number;
  readonly graceDays: number;
}

/**
 * A statement of account: what was invoiced, what was paid, and what is left.
 *
 * The running balance is accumulated in `bigint` rather than by SQL window function, because
 * the closing balance has to equal the ageing total exactly — the two appear side by side on
 * the same sheet, and a customer who finds them differing by a fils stops reading the rest.
 *
 * Invoices and payments are merged and sorted by date. Ties are broken by reference so the
 * same statement rendered twice is byte-identical: a document somebody has already argued
 * about must not reorder itself on the next print.
 *
 * ## One coupling worth naming
 *
 * The credit column is built from `payments` rows, while the ageing block sums
 * `documents.paidAmount`. Those are two sources for one fact, and they agree only because
 * `recordPayment` writes both inside one transaction. If a payment is ever recorded by any
 * other route, the closing balance and the ageing total on this sheet will disagree — and it
 * is the sheet a customer is holding when they notice. The integration suite asserts the two
 * are equal, which is where that would surface.
 */
export async function getStatementOfAccount(input: {
  tenantId: string;
  counterpartyId: string;
  fromDate: Date;
  asOf: Date;
}): Promise<Result<Statement, DomainError>> {
  return withTenantRead(async (tx) => {
    const counterparty = await tx.counterparty.findFirst({
      where: { id: input.counterpartyId, tenantId: input.tenantId },
      select: {
        id: true,
        code: true,
        nameAr: true,
        phone: true,
        email: true,
        creditProfile: { select: { graceDays: true } },
      },
    });

    if (counterparty === null) {
      return err(DomainErrors.notFound('العميل', 'Customer', input.counterpartyId));
    }

    const graceDays = counterparty.creditProfile?.graceDays ?? DEFAULT_CREDIT_TERMS.graceDays;

    const [documents, payments] = await Promise.all([
      tx.document.findMany({
        where: {
          tenantId: input.tenantId,
          counterpartyId: input.counterpartyId,
          type: { in: ['SALES_INVOICE', 'SALES_CREDIT_NOTE'] },
          status: { notIn: ['DRAFT', 'PENDING_APPROVAL', 'VOID'] },
          issueDate: { lte: input.asOf },
        },
        select: {
          documentNumber: true,
          type: true,
          issueDate: true,
          dueDate: true,
          total: true,
          paidAmount: true,
        },
      }),
      tx.payment.findMany({
        where: {
          tenantId: input.tenantId,
          counterpartyId: input.counterpartyId,
          type: 'RECEIPT',
          paymentDate: { lte: input.asOf },
        },
        select: { voucherNumber: true, paymentDate: true, amount: true },
      }),
    ]);

    interface Entry {
      date: Date;
      reference: string;
      kindAr: string;
      debit: bigint;
      credit: bigint;
      dueDate: Date | null;
    }

    const entries: Entry[] = [
      ...documents.map((document) => ({
        date: document.issueDate,
        reference: document.documentNumber,
        kindAr: document.type === 'SALES_CREDIT_NOTE' ? 'إشعار دائن' : 'فاتورة مبيعات',
        debit: document.type === 'SALES_CREDIT_NOTE' ? 0n : (toScaled(document.total.toString()) ?? 0n),
        credit: document.type === 'SALES_CREDIT_NOTE' ? (toScaled(document.total.toString()) ?? 0n) : 0n,
        dueDate: document.type === 'SALES_CREDIT_NOTE' ? null : document.dueDate,
      })),
      ...payments.map((payment) => ({
        date: payment.paymentDate,
        reference: payment.voucherNumber,
        kindAr: 'سند قبض',
        debit: 0n,
        credit: toScaled(payment.amount.toString()) ?? 0n,
        dueDate: null,
      })),
    ];

    // Date, then reference: the same statement printed twice must be identical, and sorting by
    // date alone leaves same-day rows in whatever order the two queries returned.
    entries.sort((a, b) => {
      const byDate = a.date.getTime() - b.date.getTime();
      if (byDate !== 0) return byDate;
      return a.reference.localeCompare(b.reference);
    });

    let opening = 0n;
    let balance = 0n;
    const lines: StatementLine[] = [];

    for (const entry of entries) {
      const delta = entry.debit - entry.credit;

      // Everything before the window is folded into the opening balance rather than listed.
      // A statement that starts at zero and omits the history is a statement that does not
      // reconcile to the ledger.
      if (entry.date < input.fromDate) {
        opening += delta;
        balance += delta;
        continue;
      }

      balance += delta;

      const days =
        entry.dueDate === null ? null : overdueDays(input.asOf, entry.dueDate, graceDays);

      lines.push({
        date: entry.date.toISOString().slice(0, 10),
        reference: entry.reference,
        kindAr: entry.kindAr,
        debit: fromScaled(entry.debit),
        credit: fromScaled(entry.credit),
        balance: fromScaled(balance),
        dueDate: entry.dueDate?.toISOString().slice(0, 10) ?? null,
        overdueDays: days !== null && days > 0 ? days : null,
      });
    }

    // The ageing on the statement is computed from the same open items the credit gate uses,
    // so the sheet the customer receives and the decision to stop selling to them cannot
    // disagree.
    const openItems: OpenItem[] = documents
      .filter((document) => document.total.greaterThan(document.paidAmount))
      .map((document) => {
        const outstanding = document.total.minus(document.paidAmount);
        return {
          overdueDays: overdueDays(input.asOf, document.dueDate, graceDays),
          outstanding:
            document.type === 'SALES_CREDIT_NOTE'
              ? outstanding.negated().toString()
              : outstanding.toString(),
        };
      });

    const aged = ageOpenItems(openItems);

    return ok({
      counterpartyId: counterparty.id,
      code: counterparty.code,
      nameAr: counterparty.nameAr,
      phone: counterparty.phone,
      email: counterparty.email,
      asOf: input.asOf.toISOString().slice(0, 10),
      openingBalance: fromScaled(opening),
      closingBalance: fromScaled(balance),
      lines,
      aging: {
        current: fromScaled(aged.current),
        days1to30: fromScaled(aged.days1to30),
        days31to60: fromScaled(aged.days31to60),
        days61to90: fromScaled(aged.days61to90),
        over90: fromScaled(aged.over90),
        total: fromScaled(aged.total),
        overdue: fromScaled(aged.overdue),
      },
      oldestOverdueDays: aged.oldestOverdueDays,
      graceDays,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Credit profile maintenance
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertCreditProfile(input: {
  tenantId: string;
  audit: AuditContext;
  counterpartyId: string;
  graceDays: number;
  holdAfterDays: number;
  isBlocked: boolean;
  blockReason?: string | null;
  notes?: string | null;
}): Promise<Result<{ id: string }, DomainError>> {
  if (input.holdAfterDays < input.graceDays) {
    return err(
      DomainErrors.validation(
        'حد الإيقاف يجب ألا يسبق انتهاء فترة السماح — وإلا أوقفنا البيع لعميل اتفقنا على عدم مطالبته بعد.',
        'The hold threshold cannot precede the end of the grace period.',
        'holdAfterDays',
      ),
    );
  }

  const reason = input.blockReason?.trim() ?? '';

  if (input.isBlocked && reason === '') {
    return err(
      DomainErrors.validation(
        'الإيقاف يحتاج سبباً — بلا سبب لا يعرف أحد ما الذي يرفعه.',
        'A block needs a stated reason, or nobody knows what would lift it.',
        'blockReason',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const counterparty = await tx.counterparty.findFirst({
      where: { id: input.counterpartyId, tenantId: input.tenantId },
      select: { id: true, code: true },
    });

    if (counterparty === null) {
      return err(DomainErrors.notFound('العميل', 'Customer', input.counterpartyId));
    }

    const data = {
      graceDays: input.graceDays,
      holdAfterDays: input.holdAfterDays,
      isBlocked: input.isBlocked,
      blockReason: input.isBlocked ? reason : null,
      notes: input.notes?.trim() === '' ? null : (input.notes?.trim() ?? null),
      updatedAt: new Date(),
    };

    const profile = await tx.customerCreditProfile.upsert({
      where: { counterpartyId: counterparty.id },
      create: { tenantId: input.tenantId, counterpartyId: counterparty.id, ...data },
      update: data,
      select: { id: true },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'customerCreditProfile', entityId: profile.id },
      {
        metadata: {
          code: counterparty.code,
          graceDays: input.graceDays,
          holdAfterDays: input.holdAfterDays,
          isBlocked: input.isBlocked,
        },
      },
    );

    return ok(profile);
  });
}
