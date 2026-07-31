import { FiscalCalendarBoard } from '@/components/finance/fiscal-calendar-board';
import { withPageScope } from '@/lib/api/page';
import { listFiscalYears } from '@/lib/application/services/fiscal-calendar-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'السنوات والفترات المالية' };

/**
 * The fiscal calendar.
 *
 * Not a register: closing a period here actually stops posting into it, enforced by
 * `journal-service` and by a database trigger independently of it.
 */
export default async function Page(): Promise<JSX.Element> {
  const { years, canEdit } = await withPageScope(async (context) => ({
    years: await listFiscalYears(context.tenantId),
    canEdit: context.permissions.can('finance.period', 'update'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">السنوات والفترات المالية</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          تعريف السنوات المالية وفتراتها الشهرية — وإقفال الفترات يمنع الترحيل إليها فعلياً
        </p>
      </header>

      <FiscalCalendarBoard years={years} canEdit={canEdit} />
    </div>
  );
}
