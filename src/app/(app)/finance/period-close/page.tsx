import { FiscalCalendarBoard } from '@/components/finance/fiscal-calendar-board';
import { withPageScope } from '@/lib/api/page';
import { listFiscalYears } from '@/lib/application/services/fiscal-calendar-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'إقفال الفترة' };

/**
 * Period close.
 *
 * The same board as the fiscal calendar, deliberately. Closing a period *is* an operation on
 * the calendar, and two screens showing the same rows with different close buttons would be
 * two places for the ordering rule to be enforced differently. This entry exists because
 * "close the period" is what somebody looks for under العمليات at month end, and they should
 * not have to know it lives under التهيئة.
 */
export default async function Page(): Promise<JSX.Element> {
  const { years, canEdit } = await withPageScope(async (context) => ({
    years: await listFiscalYears(context.tenantId),
    canEdit: context.permissions.can('finance.period', 'update'),
  }));

  const openPeriods = years.flatMap((year) =>
    year.periods.filter((period) => period.status === 'OPEN'),
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">إقفال الفترة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {openPeriods.length} فترة مفتوحة. الإقفال يتم بالترتيب: لا تُقفل فترة قبل ما سبقها،
          لأن الأرقام التي يعتمدها الإقفال تراكمية.
        </p>
      </header>

      <FiscalCalendarBoard years={years} canEdit={canEdit} />
    </div>
  );
}
