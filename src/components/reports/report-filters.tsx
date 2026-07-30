import { Card } from '@/components/ui/card';

/**
 * The date-range control every financial report shares.
 *
 * A plain GET form, deliberately. The period is the report's identity — a balance sheet at 31
 * March is a different document from one at 30 April — so it belongs in the URL where it can
 * be bookmarked, shared with an auditor, and reloaded without re-picking. A client-side date
 * picker holding it in React state would make the address bar lie about what is on screen.
 *
 * `fromDate` is omitted for point-in-time reports (a balance sheet is *as at* a date, not
 * *for* a period) rather than accepted and ignored. A field the report does not read is a
 * field a user will set and be misled by.
 */
export function ReportFilters({
  action,
  fromDate,
  toDate,
  showFrom = true,
  branches,
  branchId,
  extra,
}: {
  action: string;
  fromDate?: string;
  toDate: string;
  showFrom?: boolean;
  branches?: readonly { id: string; code: string; nameAr: string }[];
  branchId?: string;
  extra?: React.ReactNode;
}): JSX.Element {
  return (
    <Card>
      <form method="get" action={action} className="flex flex-wrap items-end gap-3 p-5">
        {showFrom ? (
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">من تاريخ</span>
            <input
              type="date"
              name="from"
              defaultValue={fromDate}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{showFrom ? 'إلى تاريخ' : 'كما في تاريخ'}</span>
          <input
            type="date"
            name="to"
            defaultValue={toDate}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        {branches !== undefined ? (
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">الفرع</span>
            <select
              name="branch"
              defaultValue={branchId ?? 'ALL'}
              className="h-9 min-w-[12rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="ALL">كل الفروع</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.code} · {branch.nameAr}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {extra}

        <button
          type="submit"
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          عرض التقرير
        </button>
      </form>
    </Card>
  );
}

/** Start of the current year and today, in `YYYY-MM-DD`. The default period for a P&L. */
export function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  return {
    from: `${year}-01-01`,
    to: now.toISOString().slice(0, 10),
  };
}

/** Parses a `YYYY-MM-DD` query parameter, falling back rather than throwing on a typo. */
export function parseReportDate(raw: string | undefined, fallback: string): string {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : raw;
}
