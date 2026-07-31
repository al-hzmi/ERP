import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import type { AuditContext } from '@/lib/infrastructure/audit/audit-logger';
import { recordAudit } from '@/lib/infrastructure/audit/audit-logger';
import { withTenantRead, withTransaction } from '@/lib/infrastructure/db/prisma';

/**
 * The fiscal calendar, and closing periods in it.
 *
 * This is the one screen in this release that is a real control rather than a register.
 * `journal-service` resolves every posting to a fiscal period and refuses a CLOSED one, and a
 * database trigger refuses it independently — so closing a period here genuinely stops posting
 * into it. Nothing else in this release changes what the system will accept.
 *
 * ## Why a year is created with its periods, in one transaction
 *
 * A year with no periods is worse than no year: `resolveFiscalPeriod` finds no period covering
 * the date and refuses the posting, so the calendar appears to exist while every entry is
 * rejected for a reason that points at the wrong thing. The two are created together or not at
 * all.
 *
 * ## Twelve periods, and the thirteenth that is not created
 *
 * The schema reserves `periodNumber = 13` for year-end adjustments. It is deliberately not
 * generated: an adjustment period whose dates overlap December would make
 * `resolveFiscalPeriod` — which matches on date range — ambiguous, and it resolves by picking
 * one. A thirteenth period needs a resolution rule of its own before it can exist safely.
 */

export type FiscalStatusValue = 'OPEN' | 'CLOSED' | 'LOCKED';

export interface FiscalPeriodRow {
  readonly id: string;
  readonly periodNumber: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: FiscalStatusValue;
  /** Posted entries in the period. What makes closing it a decision rather than a formality. */
  readonly journalCount: number;
}

export interface FiscalYearRow {
  readonly id: string;
  readonly year: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: FiscalStatusValue;
  readonly periods: readonly FiscalPeriodRow[];
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function listFiscalYears(tenantId: string): Promise<FiscalYearRow[]> {
  return withTenantRead(async (tx) => {
    const years = await tx.fiscalYear.findMany({
      where: { tenantId },
      select: {
        id: true,
        year: true,
        startDate: true,
        endDate: true,
        status: true,
        periods: {
          select: {
            id: true,
            periodNumber: true,
            startDate: true,
            endDate: true,
            status: true,
            _count: { select: { journals: true } },
          },
          orderBy: { periodNumber: 'asc' },
        },
      },
      orderBy: { year: 'desc' },
    });

    return years.map((year) => ({
      id: year.id,
      year: year.year,
      startDate: isoDate(year.startDate),
      endDate: isoDate(year.endDate),
      status: year.status,
      periods: year.periods.map((period) => ({
        id: period.id,
        periodNumber: period.periodNumber,
        startDate: isoDate(period.startDate),
        endDate: isoDate(period.endDate),
        status: period.status,
        journalCount: period._count.journals,
      })),
    }));
  });
}

/**
 * Creates a fiscal year and its twelve calendar-month periods.
 *
 * The months are computed in UTC and each period ends on the last day of its month, which
 * `Date.UTC(year, month + 1, 0)` gives without a table of month lengths and without getting
 * February wrong every fourth year.
 */
export async function createFiscalYear(input: {
  tenantId: string;
  audit: AuditContext;
  year: number;
}): Promise<Result<{ id: string; periods: number }, DomainError>> {
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
    return err(
      DomainErrors.validation(
        'السنة المالية يجب أن تكون بين 2000 و2100.',
        'The fiscal year must be between 2000 and 2100.',
        'year',
      ),
    );
  }

  return withTransaction(async (tx) => {
    const existing = await tx.fiscalYear.findFirst({
      where: { tenantId: input.tenantId, year: input.year },
      select: { id: true },
    });

    if (existing !== null) {
      return err(
        DomainErrors.validation(
          `السنة المالية ${input.year} موجودة بالفعل.`,
          `Fiscal year ${input.year} already exists.`,
          'year',
        ),
      );
    }

    const year = await tx.fiscalYear.create({
      data: {
        tenantId: input.tenantId,
        year: input.year,
        startDate: new Date(Date.UTC(input.year, 0, 1)),
        endDate: new Date(Date.UTC(input.year, 11, 31)),
      },
      select: { id: true },
    });

    // Twelve calendar months. Day 0 of the next month is the last day of this one.
    await tx.fiscalPeriod.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        tenantId: input.tenantId,
        fiscalYearId: year.id,
        periodNumber: index + 1,
        startDate: new Date(Date.UTC(input.year, index, 1)),
        endDate: new Date(Date.UTC(input.year, index + 1, 0)),
      })),
    });

    await recordAudit(
      tx,
      input.audit,
      'CREATE',
      { entityType: 'fiscalYear', entityId: year.id },
      { metadata: { year: input.year, periods: 12 } },
    );

    return ok({ id: year.id, periods: 12 });
  });
}

/**
 * Closes or reopens a period.
 *
 * Closing is refused while an earlier period in the same year is still open. Periods close in
 * order because the figures a close certifies are cumulative: certifying March while February
 * can still receive entries certifies a number that February can still change.
 *
 * Reopening is allowed and audited. It is a real operation — an error found after a close has
 * to be correctable — and the audit row is the compensating control.
 */
export async function setPeriodStatus(input: {
  tenantId: string;
  audit: AuditContext;
  periodId: string;
  status: 'OPEN' | 'CLOSED';
}): Promise<Result<{ id: string }, DomainError>> {
  return withTransaction(async (tx) => {
    const period = await tx.fiscalPeriod.findFirst({
      where: { id: input.periodId, tenantId: input.tenantId },
      select: {
        id: true,
        periodNumber: true,
        status: true,
        fiscalYearId: true,
        fiscalYear: { select: { year: true } },
      },
    });

    if (period === null) {
      return err(DomainErrors.notFound('الفترة المالية', 'Fiscal period', input.periodId));
    }

    if (period.status === 'LOCKED') {
      return err(
        DomainErrors.validation(
          'هذه الفترة مقفلة نهائياً ولا يمكن تغييرها.',
          'This period is permanently locked.',
        ),
      );
    }

    if (input.status === 'CLOSED') {
      const earlierOpen = await tx.fiscalPeriod.findFirst({
        where: {
          tenantId: input.tenantId,
          fiscalYearId: period.fiscalYearId,
          periodNumber: { lt: period.periodNumber },
          status: 'OPEN',
        },
        select: { periodNumber: true },
        orderBy: { periodNumber: 'asc' },
      });

      if (earlierOpen !== null) {
        return err(
          DomainErrors.validation(
            `لا يمكن إقفال الفترة ${period.periodNumber} قبل إقفال الفترة ${earlierOpen.periodNumber}.`,
            `Period ${earlierOpen.periodNumber} must be closed first.`,
          ),
        );
      }
    }

    await tx.fiscalPeriod.update({
      where: { id: period.id },
      data: { status: input.status },
    });

    await recordAudit(
      tx,
      input.audit,
      'UPDATE',
      { entityType: 'fiscalPeriod', entityId: period.id },
      {
        metadata: {
          year: period.fiscalYear.year,
          periodNumber: period.periodNumber,
          from: period.status,
          to: input.status,
        },
      },
    );

    return ok({ id: period.id });
  });
}
