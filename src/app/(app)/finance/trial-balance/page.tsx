import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { getTrialBalance } from '@/lib/application/services/report-service';
import { getRequestContext } from '@/lib/infrastructure/auth/request-context';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'ميزان المراجعة' };

const TYPE_LABELS: Record<string, string> = {
  ASSET: 'أصول',
  LIABILITY: 'التزامات',
  EQUITY: 'حقوق ملكية',
  REVENUE: 'إيرادات',
  EXPENSE: 'مصروفات',
};

/**
 * The trial balance.
 *
 * The banner at the top is the point of the whole report: an accountant opens
 * this to answer one question — does the ledger balance — and that answer should
 * be legible from across the room, not derived by adding up two columns by eye.
 */
export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}): Promise<JSX.Element> {
  const context = await getRequestContext();
  if (!context.ok) return <p>غير مصرح.</p>;

  const permitted = context.value.permissions.can('finance.report', 'read');
  if (!permitted) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-destructive">ليس لديك صلاحية الاطلاع على التقارير المالية.</p>
      </Card>
    );
  }

  const year = new Date().getUTCFullYear();
  const from = searchParams.from ?? `${year}-01-01`;
  const to = searchParams.to ?? `${year}-12-31`;

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: context.value.tenantId },
    select: { functionalCurrency: true, nameAr: true },
  });

  const report = await getTrialBalance({
    tenantId: context.value.tenantId,
    fromDate: new Date(from),
    toDate: new Date(to),
    currency: tenant.functionalCurrency,
  });

  const currency = tenant.functionalCurrency;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">ميزان المراجعة</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tenant.nameAr} — من <span className="bidi-isolate">{from}</span> إلى{' '}
            <span className="bidi-isolate">{to}</span>
          </p>
        </div>
      </header>

      <div
        className={
          report.isBalanced
            ? 'flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3'
            : 'flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3'
        }
        role="status"
      >
        {report.isBalanced ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <div className="min-w-0 text-sm">
          <p className={report.isBalanced ? 'font-medium text-success' : 'font-medium text-destructive'}>
            {report.isBalanced
              ? 'الميزان متوازن — إجمالي المدين يساوي إجمالي الدائن'
              : 'الميزان غير متوازن — يرجى مراجعة القيود'}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            مدين <span className="numeric">{formatMoney(report.totalDebit, { currency })}</span>
            {' · '}
            دائن <span className="numeric">{formatMoney(report.totalCredit, { currency })}</span>
          </p>
        </div>
      </div>

      <Card>
        <CardHeader
          title="الحسابات"
          description="الحسابات القابلة للترحيل فقط؛ الأرصدة معروضة باتجاه طبيعة كل حساب"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رمز الحساب</th>
                <th scope="col">اسم الحساب</th>
                <th scope="col">النوع</th>
                <th scope="col" className="numeric">الرصيد الافتتاحي</th>
                <th scope="col" className="numeric">مدين الفترة</th>
                <th scope="col" className="numeric">دائن الفترة</th>
                <th scope="col" className="numeric">الرصيد الختامي</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    لا توجد حركات في هذه الفترة
                  </td>
                </tr>
              ) : (
                report.rows.map((row) => (
                  <tr key={row.accountId}>
                    <td>
                      <span className="bidi-isolate font-mono text-xs text-primary">{row.code}</span>
                    </td>
                    <td className="max-w-xs truncate">{row.nameAr}</td>
                    <td className="text-xs text-muted-foreground">
                      {TYPE_LABELS[row.type] ?? row.type}
                    </td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.openingBalance, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric">
                      {formatMoney(row.periodDebit, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric">
                      {formatMoney(row.periodCredit, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric font-medium">
                      {formatMoney(row.closingBalance, { currency, showCurrency: false })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                <td colSpan={4} className="px-4 py-3">
                  الإجمالي
                </td>
                <td className="numeric px-4 py-3">
                  {formatMoney(report.totalDebit, { currency, showCurrency: false })}
                </td>
                <td className="numeric px-4 py-3">
                  {formatMoney(report.totalCredit, { currency, showCurrency: false })}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}
