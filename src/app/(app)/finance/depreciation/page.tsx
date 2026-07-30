import { DepreciationRun } from '@/components/finance/depreciation-run';

export const metadata = { title: 'إهلاك الأصول الثابتة' };

/**
 * Fixed asset depreciation.
 *
 * `fixed_assets` and `depreciation_schedules` shipped in migration 1 and nothing ever wrote
 * to them. `depreciation-service.ts` drives them, migration 008 adds the constraints they
 * never had — including the row-level security policy the schedule table was missing
 * entirely — and this is what a controller sees when closing a month.
 */
export default function DepreciationPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">إهلاك الأصول الثابتة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          توليد جداول الإهلاك وترحيل الأقساط المستحقة في قيد واحد، دون المساس بتكلفة الأصل.
        </p>
      </header>

      <DepreciationRun />
    </div>
  );
}
