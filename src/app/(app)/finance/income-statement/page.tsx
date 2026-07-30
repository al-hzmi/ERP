import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getIncomeStatement } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'قائمة الدخل' };

/**
 * The income statement.
 *
 * Unlike the balance sheet this is a *period* report, so both dates matter and both are in
 * the URL. `netMargin` comes back as `null` rather than zero when revenue is zero — dividing
 * by nothing has no answer, and rendering "0%" would state one.
 */
export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; branch?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const fromDate = parseReportDate(searchParams.from, fallback.from);
  const toDate = parseReportDate(searchParams.to, fallback.to);
  const branchId = searchParams.branch;

  const { statement, branches, currency } = await withPageScope(async (context) => {
    const [tenant, loadedBranches] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
      prisma.branch.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
    ]);

    const loaded = await getIncomeStatement({
      tenantId: context.tenantId,
      fromDate: new Date(`${fromDate}T00:00:00.000Z`),
      toDate: new Date(`${toDate}T00:00:00.000Z`),
      ...(branchId !== undefined && branchId !== 'ALL' ? { branchId } : {}),
      currency: tenant.functionalCurrency,
    });

    return { statement: loaded, branches: loadedBranches, currency: tenant.functionalCurrency };
  });

  const profitable = !statement.netProfit.trimStart().startsWith('-');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">قائمة الدخل</h1>
        <p className="mt-1 text-sm text-muted-foreground">الإيرادات والمصروفات عن الفترة المحددة</p>
      </header>

      <ReportFilters
        action="/finance/income-statement"
        fromDate={fromDate}
        toDate={toDate}
        branches={branches}
        branchId={branchId}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="إجمالي الإيرادات" value={formatMoney(statement.totalRevenue, { currency })} />
        <Tile label="إجمالي المصروفات" value={formatMoney(statement.totalExpenses, { currency })} />
        <Tile
          label={profitable ? 'صافي الربح' : 'صافي الخسارة'}
          value={formatMoney(statement.netProfit, { currency })}
          hint={
            statement.netMargin === null
              ? 'هامش الربح غير معرَّف — لا توجد إيرادات في الفترة'
              : `هامش الربح ${statement.netMargin}%`
          }
          tone={profitable ? 'success' : 'danger'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="الإيرادات"
          lines={statement.revenue}
          total={statement.totalRevenue}
          currency={currency}
        />
        <Section
          title="المصروفات"
          lines={statement.expenses}
          total={statement.totalExpenses}
          currency={currency}
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'success' | 'danger';
}): JSX.Element {
  return (
    <Card>
      <CardBody>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={
            tone === 'success'
              ? 'numeric mt-1 text-2xl font-semibold tracking-tight text-success'
              : tone === 'danger'
                ? 'numeric mt-1 text-2xl font-semibold tracking-tight text-destructive'
                : 'numeric mt-1 text-2xl font-semibold tracking-tight'
          }
        >
          {value}
        </p>
        {hint !== undefined ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}

function Section({
  title,
  lines,
  total,
  currency,
}: {
  title: string;
  lines: readonly { accountId: string; code: string; nameAr: string; amount: string }[];
  total: string;
  currency: string;
}): JSX.Element {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">الحساب</th>
              <th scope="col" className="numeric">المبلغ</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={2} className="py-10 text-center text-muted-foreground">
                  لا توجد حركة في هذا القسم خلال الفترة
                </td>
              </tr>
            ) : (
              lines.map((line) => (
                <tr key={line.accountId}>
                  <td>
                    <span className="bidi-isolate font-mono text-xs text-muted-foreground">
                      {line.code}
                    </span>
                    <span className="ms-2">{line.nameAr}</span>
                  </td>
                  <td className="numeric">
                    {formatMoney(line.amount, { currency, showCurrency: false })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td>الإجمالي</td>
              <td className="numeric">{formatMoney(total, { currency, showCurrency: false })}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
