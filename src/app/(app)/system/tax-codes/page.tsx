import { TaxCodeManager } from '@/components/system/tax-code-manager';
import { withPageScope } from '@/lib/api/page';
import { listTaxCodes } from '@/lib/application/services/tax-code-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'إعدادات الضرائب' };

/**
 * Tax codes.
 *
 * `finance.account:update` authority: a tax code decides how a supply is declared to ZATCA,
 * which is the same class of decision as reshaping the chart of accounts — not something a
 * sales clerk changes mid-invoice.
 */
export default async function Page(): Promise<JSX.Element> {
  const { codes, canEdit } = await withPageScope(async (context) => ({
    codes: await listTaxCodes(context.tenantId),
    canEdit: context.permissions.can('finance.account', 'update'),
  }));

  const active = codes.filter((code) => code.isActive).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">إعدادات الضرائب</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {active} رمز ضريبي مفعَّل. النسبة ليست هي المعالجة: التوريد بنسبة صفر والتوريد المعفى
          كلاهما 0%، لكن الأول يظهر في الإقرار الضريبي والثاني لا يظهر، وتكتب لهما الهيئة تصنيفين
          مختلفين في ملف الفاتورة الإلكترونية — لذلك تُختار المعالجة وتُشتق منها النسبة والتصنيف.
        </p>
      </header>

      <TaxCodeManager codes={codes} canEdit={canEdit} />
    </div>
  );
}
