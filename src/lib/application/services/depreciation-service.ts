import { Prisma } from '@prisma/client';
import { JournalEntryDraft } from '@/lib/domain/accounting/journal-entry';
import {
  buildSchedule,
  type AssetTerms,
  type DepreciationMethod,
  type SchedulePeriod,
} from '@/lib/domain/assets/depreciation';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { Money } from '@/lib/domain/shared/money';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { fromMoney, toMoney } from '@/lib/infrastructure/db/decimal-mapper';
import { withTenantRead, withTransaction, type TransactionClient } from '@/lib/infrastructure/db/prisma';
import { logger } from '@/lib/infrastructure/logging/logger';
import { persistJournalEntry } from './journal-service';

/**
 * Fixed asset depreciation.
 *
 * `fixed_assets` and `depreciation_schedules` shipped in migration 1 and nothing ever wrote
 * to them. This is what drives them, and it separates two things that are usually
 * conflated:
 *
 *   - **generating a schedule** — pure arithmetic over the asset's terms, producing one row
 *     per month for the asset's whole life, none of them posted;
 *   - **running a period** — turning every charge now due into one journal entry.
 *
 * Splitting them is what makes the register auditable. The schedule is visible and
 * reviewable *before* anything hits the ledger, and the run has no arithmetic of its own to
 * get wrong: it posts amounts that were computed, reviewed and stored earlier. A design that
 * computed the charge at posting time would give a different answer if the asset's terms
 * were edited midway through its life, with no record that they had been.
 *
 * ## What a run refuses to do
 *
 * **Skip a month.** If an asset has an unposted period *earlier* than one now due, the whole
 * asset is left out of the run and reported as skipped. Posting April while March is still
 * open would make the asset register's `accumulatedDepreciation` — which is read from the
 * last posted period's cumulative column — overstate what has actually been charged, and
 * nothing downstream would reveal it.
 *
 * **Touch a disposed asset.** Disposal closes the asset's life; depreciation after it is
 * expense against something the company no longer owns.
 *
 * **Post twice.** Two clerks running the same period concurrently both see the same due
 * rows, and both would post. The flip to `isPosted` is inside the same `SERIALIZABLE`
 * transaction as the journal, so the second commit fails on the write conflict, retries, and
 * finds nothing due. The protection is the transaction, not a check — a check would let both
 * pass in the same instant.
 *
 * ## One journal per run, not per asset
 *
 * A hundred assets produce a hundred lines in one entry, compacted by account, which is what
 * an accountant expects to receive from a monthly depreciation run. A hundred journals would
 * be a hundred entries to review and a hundred rows in the trial balance's audit trail for
 * one policy decision.
 */

/** Rows the run left out, and why. Reported rather than silently dropped. */
export interface SkippedAsset {
  readonly assetId: string;
  readonly assetNumber: string;
  readonly reasonAr: string;
  readonly reasonEn: string;
}

export interface DueCharge {
  readonly scheduleId: string;
  readonly assetId: string;
  readonly assetNumber: string;
  readonly assetNameAr: string;
  readonly periodDate: string;
  readonly amount: string;
  readonly expenseAccountCode: string;
  readonly accumulatedAccountCode: string;
}

export interface RunPreview {
  readonly asOf: string;
  readonly charges: readonly DueCharge[];
  readonly totalAmount: string;
  readonly skipped: readonly SkippedAsset[];
}

export interface RunResult {
  readonly asOf: string;
  readonly journalId: string | null;
  readonly entryNumber: string | null;
  readonly postedCount: number;
  readonly totalAmount: string;
  readonly skipped: readonly SkippedAsset[];
}

export interface AssetListItem {
  readonly id: string;
  readonly assetNumber: string;
  readonly nameAr: string;
  readonly method: DepreciationMethod;
  readonly acquisitionDate: string;
  readonly acquisitionCost: string;
  readonly salvageValue: string;
  readonly usefulLifeMonths: number;
  readonly accumulatedDepreciation: string;
  readonly netBookValue: string;
  readonly disposedAt: string | null;
  readonly scheduledPeriods: number;
  readonly postedPeriods: number;
  /** Earliest unposted period, or `null` when the schedule is exhausted or absent. */
  readonly nextDueDate: string | null;
}

export interface AssetScheduleView {
  readonly asset: AssetListItem & {
    readonly nameEn: string;
    readonly decliningFactor: string;
    readonly expenseAccountCode: string;
    readonly accumulatedAccountCode: string;
  };
  readonly periods: readonly {
    id: string;
    periodDate: string;
    amount: string;
    accumulated: string;
    netBookValue: string;
    isPosted: boolean;
    journalId: string | null;
    postedAt: string | null;
  }[];
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The columns the domain needs to build a schedule.
 *
 * `decliningFactor` is stringified rather than converted to a number: it feeds
 * `Money.multiply`, which takes a decimal string precisely so a rate never round-trips
 * through a float.
 */
type AssetTermsRow = {
  acquisitionCost: Prisma.Decimal;
  salvageValue: Prisma.Decimal;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  decliningFactor: Prisma.Decimal;
  acquisitionDate: Date;
};

function termsOf(row: AssetTermsRow, currency: string): AssetTerms {
  return {
    acquisitionCost: toMoney(row.acquisitionCost, currency),
    salvageValue: toMoney(row.salvageValue, currency),
    usefulLifeMonths: row.usefulLifeMonths,
    method: row.method,
    decliningFactor: row.decliningFactor.toString(),
    acquisitionDate: DateOnly.fromDate(row.acquisitionDate),
  };
}

/** The tenant's reporting currency. Every asset is stated in it; there is no FX on a register. */
async function functionalCurrency(tx: TransactionClient, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { functionalCurrency: true },
  });
  return tenant?.functionalCurrency ?? 'SAR';
}

/** The asset register, with schedule progress per asset. */
export async function listAssets(input: {
  tenantId: string;
  includeDisposed?: boolean;
}): Promise<AssetListItem[]> {
  return withTenantRead(async (tx) => {
    const assets = await tx.fixedAsset.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.includeDisposed === true ? {} : { disposedAt: null }),
      },
      select: {
        id: true,
        assetNumber: true,
        nameAr: true,
        method: true,
        acquisitionDate: true,
        acquisitionCost: true,
        salvageValue: true,
        usefulLifeMonths: true,
        accumulatedDepreciation: true,
        netBookValue: true,
        disposedAt: true,
        schedules: {
          select: { periodDate: true, isPosted: true },
          orderBy: { periodDate: 'asc' },
        },
      },
      orderBy: { assetNumber: 'asc' },
      take: 500,
    });

    return assets.map((asset) => {
      const posted = asset.schedules.filter((period) => period.isPosted);
      // Schedules come back in period order, so the first unposted row *is* the next due one.
      const next = asset.schedules.find((period) => !period.isPosted);

      return {
        id: asset.id,
        assetNumber: asset.assetNumber,
        nameAr: asset.nameAr,
        method: asset.method,
        acquisitionDate: isoDate(asset.acquisitionDate),
        acquisitionCost: asset.acquisitionCost.toString(),
        salvageValue: asset.salvageValue.toString(),
        usefulLifeMonths: asset.usefulLifeMonths,
        accumulatedDepreciation: asset.accumulatedDepreciation.toString(),
        netBookValue: asset.netBookValue.toString(),
        disposedAt: asset.disposedAt === null ? null : isoDate(asset.disposedAt),
        scheduledPeriods: asset.schedules.length,
        postedPeriods: posted.length,
        nextDueDate: next === undefined ? null : isoDate(next.periodDate),
      };
    });
  });
}

/** One asset's full schedule, for the drill-down. */
export async function getAssetSchedule(input: {
  tenantId: string;
  assetId: string;
}): Promise<Result<AssetScheduleView, DomainError>> {
  return withTenantRead(async (tx) => {
    const asset = await tx.fixedAsset.findFirst({
      where: { id: input.assetId, tenantId: input.tenantId },
      select: {
        id: true,
        assetNumber: true,
        nameAr: true,
        nameEn: true,
        method: true,
        decliningFactor: true,
        acquisitionDate: true,
        acquisitionCost: true,
        salvageValue: true,
        usefulLifeMonths: true,
        accumulatedDepreciation: true,
        netBookValue: true,
        disposedAt: true,
        expenseAccount: { select: { code: true } },
        accumulatedAccount: { select: { code: true } },
        schedules: {
          select: {
            id: true,
            periodDate: true,
            amount: true,
            accumulated: true,
            netBookValue: true,
            isPosted: true,
            journalId: true,
            postedAt: true,
          },
          orderBy: { periodDate: 'asc' },
        },
      },
    });

    if (asset === null) {
      return err(DomainErrors.notFound('الأصل الثابت', 'Fixed asset', input.assetId));
    }

    const posted = asset.schedules.filter((period) => period.isPosted);
    const next = asset.schedules.find((period) => !period.isPosted);

    return ok({
      asset: {
        id: asset.id,
        assetNumber: asset.assetNumber,
        nameAr: asset.nameAr,
        nameEn: asset.nameEn,
        method: asset.method,
        decliningFactor: asset.decliningFactor.toString(),
        acquisitionDate: isoDate(asset.acquisitionDate),
        acquisitionCost: asset.acquisitionCost.toString(),
        salvageValue: asset.salvageValue.toString(),
        usefulLifeMonths: asset.usefulLifeMonths,
        accumulatedDepreciation: asset.accumulatedDepreciation.toString(),
        netBookValue: asset.netBookValue.toString(),
        disposedAt: asset.disposedAt === null ? null : isoDate(asset.disposedAt),
        scheduledPeriods: asset.schedules.length,
        postedPeriods: posted.length,
        nextDueDate: next === undefined ? null : isoDate(next.periodDate),
        expenseAccountCode: asset.expenseAccount.code,
        accumulatedAccountCode: asset.accumulatedAccount.code,
      },
      periods: asset.schedules.map((period) => ({
        id: period.id,
        periodDate: isoDate(period.periodDate),
        amount: period.amount.toString(),
        accumulated: period.accumulated.toString(),
        netBookValue: period.netBookValue.toString(),
        isPosted: period.isPosted,
        journalId: period.journalId,
        postedAt: period.postedAt === null ? null : period.postedAt.toISOString(),
      })),
    });
  });
}

/**
 * Generates the missing periods of an asset's schedule.
 *
 * Idempotent by construction: `(assetId, periodDate)` is unique, so re-running inserts only
 * what is absent. Existing rows are never rewritten, and that is deliberate — a posted row
 * is a charge already in the ledger, and an unposted row may have been reviewed. Regenerating
 * over the top would silently replace reviewed figures with recomputed ones.
 *
 * The consequence is that changing an asset's terms mid-life does not retro-fit the schedule.
 * That is the honest behaviour: revising a useful life is a change in accounting estimate,
 * which IAS 8 applies prospectively, and doing it properly means writing off the remaining
 * book value over the new remaining life — a different operation from generating a schedule,
 * and not one to do by quietly overwriting rows.
 */
export async function generateSchedule(input: {
  tenantId: string;
  assetId: string;
  audit: AuditContext;
}): Promise<Result<{ assetId: string; created: number; existing: number; total: number }, DomainError>> {
  return withTransaction(async (tx) => {
    const asset = await tx.fixedAsset.findFirst({
      where: { id: input.assetId, tenantId: input.tenantId },
      select: {
        id: true,
        assetNumber: true,
        acquisitionCost: true,
        salvageValue: true,
        usefulLifeMonths: true,
        method: true,
        decliningFactor: true,
        acquisitionDate: true,
        disposedAt: true,
        isActive: true,
      },
    });

    if (asset === null) {
      return err(DomainErrors.notFound('الأصل الثابت', 'Fixed asset', input.assetId));
    }

    if (asset.disposedAt !== null) {
      return err(
        DomainErrors.validation(
          'لا يمكن توليد جدول إهلاك لأصل مُستبعد.',
          'A disposed asset has no remaining life to schedule.',
        ),
      );
    }

    const currency = await functionalCurrency(tx, input.tenantId);
    const schedule = buildSchedule(termsOf(asset, currency));
    if (!schedule.ok) return schedule;

    const existing = await tx.depreciationSchedule.findMany({
      where: { assetId: asset.id },
      select: { periodDate: true },
    });

    const known = new Set(existing.map((period) => isoDate(period.periodDate)));
    const missing = schedule.value.filter(
      (period) => !known.has(period.periodDate.toString()),
    );

    if (missing.length > 0) {
      await tx.depreciationSchedule.createMany({
        data: missing.map((period) => ({
          tenantId: input.tenantId,
          assetId: asset.id,
          periodDate: period.periodDate.toDate(),
          amount: fromMoney(period.amount),
          accumulated: fromMoney(period.accumulated),
          netBookValue: fromMoney(period.netBookValue),
        })),
        // Belt and braces against a concurrent generator: the unique index is the real
        // guarantee, and this keeps the loser of the race from failing the whole request over
        // rows the winner already wrote correctly.
        skipDuplicates: true,
      });
    }

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'DepreciationSchedule', entityId: asset.id },
      {
        metadata: {
          assetNumber: asset.assetNumber,
          method: asset.method,
          periodsCreated: missing.length,
          periodsExisting: known.size,
        },
      },
    );

    logger.info('Depreciation schedule generated', {
      assetId: asset.id,
      created: missing.length,
      existing: known.size,
    });

    return ok({
      assetId: asset.id,
      created: missing.length,
      existing: known.size,
      total: schedule.value.length,
    });
  });
}

/**
 * The set of charges a run at `asOf` would post, and the assets it would leave out.
 *
 * Shared by the preview and the run itself, so what the screen shows and what the run does
 * cannot disagree — the commonest way a "confirm before posting" dialog becomes a lie.
 */
async function collectDue(
  tx: TransactionClient,
  tenantId: string,
  asOf: Date,
): Promise<{
  charges: {
    scheduleId: string;
    assetId: string;
    assetNumber: string;
    assetNameAr: string;
    periodDate: Date;
    amount: Prisma.Decimal;
    expenseAccountId: string;
    accumulatedAccountId: string;
    expenseAccountCode: string;
    accumulatedAccountCode: string;
    accumulated: Prisma.Decimal;
  }[];
  skipped: SkippedAsset[];
}> {
  // Every unposted period of every live asset, not only the due ones: deciding whether an
  // asset has an *earlier* gap needs the rows before the cutoff too, and fetching them in the
  // same query is what makes that check free.
  const rows = await tx.depreciationSchedule.findMany({
    where: {
      tenantId,
      isPosted: false,
      asset: { disposedAt: null, isActive: true },
    },
    select: {
      id: true,
      periodDate: true,
      amount: true,
      accumulated: true,
      asset: {
        select: {
          id: true,
          assetNumber: true,
          nameAr: true,
          expenseAccountId: true,
          accumulatedAccountId: true,
          expenseAccount: { select: { code: true } },
          accumulatedAccount: { select: { code: true } },
        },
      },
    },
    orderBy: [{ assetId: 'asc' }, { periodDate: 'asc' }],
  });

  const charges: Awaited<ReturnType<typeof collectDue>>['charges'] = [];
  const skipped: SkippedAsset[] = [];

  /**
   * Assets whose schedule is posted out of order.
   *
   * The invariant the register depends on is that the posted periods are a *prefix* of the
   * schedule — because `accumulatedDepreciation` is read from the cumulative column of the
   * last posted period, which is only the true total when every period before it is posted
   * too. So the thing to look for is a posted period *later* than an unposted one.
   *
   * Under normal operation this cannot happen; it takes a row being reopened after later ones
   * were charged, or periods being generated beneath already-posted ones. Both are repairs
   * gone wrong rather than ordinary use, and both silently overstate the register — which is
   * exactly the class of error worth a query to catch.
   *
   * Raw SQL because the comparison is per asset against that asset's own earliest open period,
   * which is a correlated aggregate rather than a filter Prisma's query builder can express.
   */
  const outOfOrder = await tx.$queryRaw<{ assetId: string }[]>`
    SELECT ds."assetId"
      FROM "depreciation_schedules" ds
      JOIN (
            SELECT "assetId", min("periodDate") AS first_open
              FROM "depreciation_schedules"
             WHERE "tenantId" = ${tenantId}::uuid AND NOT "isPosted"
             GROUP BY "assetId"
           ) open_periods ON open_periods."assetId" = ds."assetId"
     WHERE ds."tenantId" = ${tenantId}::uuid
       AND ds."isPosted"
       AND ds."periodDate" > open_periods.first_open
     GROUP BY ds."assetId"
  `;

  const broken = new Set(outOfOrder.map((row) => row.assetId));

  // Grouped per asset because the ordering rule is per asset: one asset's missing March says
  // nothing about another's.
  const byAsset = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byAsset.get(row.asset.id);
    if (bucket === undefined) byAsset.set(row.asset.id, [row]);
    else bucket.push(row);
  }

  for (const periods of byAsset.values()) {
    const due = periods.filter((period) => period.periodDate.getTime() <= asOf.getTime());
    if (due.length === 0) continue;

    const asset = periods[0]?.asset;
    if (asset === undefined) continue;

    if (broken.has(asset.id)) {
      skipped.push({
        assetId: asset.id,
        assetNumber: asset.assetNumber,
        reasonAr: 'جدول الإهلاك مُرحَّل بغير ترتيبه — يوجد قسط أقدم غير مُرحَّل.',
        reasonEn: 'This asset has a posted period later than an earlier unposted one.',
      });
      continue;
    }

    for (const period of due) {
      charges.push({
        scheduleId: period.id,
        assetId: asset.id,
        assetNumber: asset.assetNumber,
        assetNameAr: asset.nameAr,
        periodDate: period.periodDate,
        amount: period.amount,
        accumulated: period.accumulated,
        expenseAccountId: asset.expenseAccountId,
        accumulatedAccountId: asset.accumulatedAccountId,
        expenseAccountCode: asset.expenseAccount.code,
        accumulatedAccountCode: asset.accumulatedAccount.code,
      });
    }
  }

  return { charges, skipped };
}

/** What a run at `asOf` would do, without doing it. */
export async function previewRun(input: {
  tenantId: string;
  asOf: DateOnly;
}): Promise<Result<RunPreview, DomainError>> {
  return withTenantRead(async (tx) => {
    const currency = await functionalCurrency(tx, input.tenantId);
    const { charges, skipped } = await collectDue(tx, input.tenantId, input.asOf.toDate());

    const total = Money.sum(
      charges.map((charge) => toMoney(charge.amount, currency)),
      currency,
    );

    return ok({
      asOf: input.asOf.toString(),
      charges: charges.map((charge) => ({
        scheduleId: charge.scheduleId,
        assetId: charge.assetId,
        assetNumber: charge.assetNumber,
        assetNameAr: charge.assetNameAr,
        periodDate: isoDate(charge.periodDate),
        amount: charge.amount.toString(),
        expenseAccountCode: charge.expenseAccountCode,
        accumulatedAccountCode: charge.accumulatedAccountCode,
      })),
      totalAmount: total.toString(),
      skipped,
    });
  });
}

/**
 * Posts every charge due at `asOf` as one depreciation journal.
 *
 * The entry is `Dr depreciation expense / Cr accumulated depreciation` per asset, compacted
 * by account. Accumulated depreciation is a contra-asset — an asset account carrying a credit
 * balance, which migration 3 made expressible — so the credit reduces the asset side of the
 * balance sheet without touching the asset's historical cost. Writing the cost down directly
 * would destroy the one number a fixed asset register exists to preserve.
 */
export async function runDepreciation(input: {
  tenantId: string;
  asOf: DateOnly;
  userId: string;
  audit: AuditContext;
}): Promise<Result<RunResult, DomainError>> {
  return withTransaction(async (tx) => {
    const currency = await functionalCurrency(tx, input.tenantId);
    const asOf = input.asOf.toDate();
    const { charges, skipped } = await collectDue(tx, input.tenantId, asOf);

    if (charges.length === 0) {
      // Not an error. "Nothing was due" is the correct answer to a run on a period already
      // posted, and returning a failure would train people to ignore failures.
      return ok({
        asOf: input.asOf.toString(),
        journalId: null,
        entryNumber: null,
        postedCount: 0,
        totalAmount: Money.zero(currency).toString(),
        skipped,
      });
    }

    const draft = new JournalEntryDraft({
      tenantId: input.tenantId,
      type: 'DEPRECIATION',
      // Dated at the cutoff, not at each period's own month end: one entry cannot carry two
      // dates, and a catch-up run covering three months belongs in the period it is made in.
      date: input.asOf,
      descriptionAr: `إهلاك الأصول الثابتة حتى ${input.asOf.toString()}`,
      descriptionEn: `Fixed asset depreciation through ${input.asOf.toString()}`,
      referenceType: 'DEPRECIATION_RUN',
      referenceId: input.asOf.toString(),
      currency,
      exchangeRate: '1.000000',
      functionalCurrency: currency,
    });

    for (const charge of charges) {
      const amount = toMoney(charge.amount, currency);
      // Deliberately *not* stamped with the asset number. `compact()` groups by account and
      // description together, so a per-asset note would defeat it and put one line per asset
      // per month in the ledger — five hundred lines for a register of a hundred assets, and
      // a trial balance nobody can read. The asset-level detail is not lost: every
      // `depreciation_schedules` row carries this journal's id, which is the register's own
      // drill-down and the more reliable place for it.
      draft.debit(charge.expenseAccountId, amount, { description: 'إهلاك الفترة' });
      draft.credit(charge.accumulatedAccountId, amount, { description: 'إهلاك الفترة' });
    }

    const entry = draft.compact().validate();
    if (!entry.ok) return entry;

    const posted = await persistJournalEntry(tx, entry.value, {
      audit: input.audit,
      createdById: input.userId,
      postImmediately: true,
    });
    if (!posted.ok) return posted;

    const now = new Date();

    await tx.depreciationSchedule.updateMany({
      where: { id: { in: charges.map((charge) => charge.scheduleId) } },
      data: { isPosted: true, journalId: posted.value.journalId, postedAt: now },
    });

    // The register's own columns, from the last period posted per asset. Read from the
    // schedule's cumulative column rather than added up here, so the register and the schedule
    // cannot disagree — and the gap rule above is what makes "last" mean "all of them".
    const latestPerAsset = new Map<string, Prisma.Decimal>();
    for (const charge of charges) {
      latestPerAsset.set(charge.assetId, charge.accumulated);
    }

    for (const [assetId, accumulated] of latestPerAsset) {
      const asset = await tx.fixedAsset.findUniqueOrThrow({
        where: { id: assetId },
        select: { acquisitionCost: true },
      });

      await tx.fixedAsset.update({
        where: { id: assetId },
        data: {
          accumulatedDepreciation: accumulated,
          netBookValue: asset.acquisitionCost.minus(accumulated),
        },
      });
    }

    const total = Money.sum(
      charges.map((charge) => toMoney(charge.amount, currency)),
      currency,
    );

    await recordAudit(
      tx,
      input.audit,
      'POST',
      { entityType: 'DepreciationRun', entityId: posted.value.journalId },
      {
        metadata: {
          asOf: input.asOf.toString(),
          entryNumber: posted.value.entryNumber,
          periodsPosted: charges.length,
          assetsPosted: latestPerAsset.size,
          totalAmount: total.toString(),
          assetsSkipped: skipped.length,
        },
      },
    );

    logger.info('Depreciation run posted', {
      tenantId: input.tenantId,
      asOf: input.asOf.toString(),
      journalId: posted.value.journalId,
      periods: charges.length,
      skipped: skipped.length,
    });

    return ok({
      asOf: input.asOf.toString(),
      journalId: posted.value.journalId,
      entryNumber: posted.value.entryNumber,
      postedCount: charges.length,
      totalAmount: total.toString(),
      skipped,
    });
  });
}

/** Re-exported so a caller can type a schedule without reaching into the domain module. */
export type { SchedulePeriod };
