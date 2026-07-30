import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getBalanceSheet } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'قائمة المركز المالي' };

/**
 * The balance sheet.
 *
 * `getBalanceSheet` has existed since the first commit with no screen. Two properties it
 * already guarantees are surfaced here rather than left implicit:
 *
 * **The period's profit is folded into equity explicitly.** Without it the sheet fails to
 * balance on every day of the year except 31 December, because retained earnings have not
 * been closed out yet. It is shown as its own line so nobody has to wonder where the
 * difference went.
 *
 * **`isBalanced` is the headline.** A balance sheet that does not balance is not a report with
 * a small error in it — it is evidence the ledger is broken, and burying that under the asset
 * total would be the wrong emphasis entirely.
 */
export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: { to?: string; branch?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const toDate = parseReportDate(searchParams.to, fallback.to);
  const branchId = searchParams.branch;

  const { sheet, branches, currency } = await withPageScope(async (context) => {
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

    const loaded = await getBalanceSheet({
      tenantId: context.tenantId,
      // A balance sheet is cumulative: everything ever posted up to `toDate`. The epoch here
      // is not a magic number, it is "no lower bound".
      fromDate: new Date('1900-01-01T00:00:00.000Z'),
      toDate: new Date(`${toDate}T00:00:00.000Z`),
      ...(branchId !== undefined && branchId !== 'ALL' ? { branchId } : {}),
      currency: tenant.functionalCurrency,
    });

    return { sheet: loaded, branches: loadedBranches, currency: tenant.functionalCurrency };
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">قائمة المركز المالي</h1>
        <p className="mt-1 text-sm text-muted-foreground">الأصول = الخصوم + حقوق الملكية، كما في تاريخ محدد</p>
      </header>

      <ReportFilters
        action="/finance/balance-sheet"
        toDate={toDate}
        showFrom={false}
        branches={branches}
        branchId={branchId}
      />

      <div
        role="status"
        aria-live="polite"
        className={
          sheet.isBalanced
            ? 'rounded-lg border border-success/30 bg-success/10 px-4 py-3'
            : 'rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3'
        }
      >
        <div className="flex items-start gap-3">
          {sheet.isBalanced ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className={sheet.isBalanced ? 'text-sm font-medium text-success' : 'text-sm font-medium text-destructive'}>
              {sheet.isBalanced
                ? 'القائمة متوازنة — الأصول تساوي الخصوم وحقوق الملكية'
                : 'القائمة غير متوازنة — هذا خلل في الأستاذ لا خطأ في التقرير'}
            </p>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
              <Pair label="إجمالي الأصول" value={formatMoney(sheet.totalAssets, { currency })} />
              <Pair label="إجمالي الخصوم" value={formatMoney(sheet.totalLiabilities, { currency })} />
              <Pair label="إجمالي حقوق الملكية" value={formatMoney(sheet.totalEquity, { currency })} />
            </dl>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="الأصول" lines={sheet.assets} total={sheet.totalAssets} currency={currency} />
        <div className="space-y-6">
          <Section
            title="الخصوم"
            lines={sheet.liabilities}
            total={sheet.totalLiabilities}
            currency={currency}
          />
          <Section
            title="حقوق الملكية"
            lines={sheet.equity}
            total={sheet.totalEquity}
            currency={currency}
            footnote={{
              label: 'من ضمنها: نتيجة الفترة الحالية',
              value: formatMoney(sheet.currentPeriodProfit, { currency }),
              hint: 'تُضاف صراحةً لأن الأرباح المحتجزة لم تُقفَل بعد — بدونها لا تتوازن القائمة إلا في 31 ديسمبر',
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  lines,
  total,
  currency,
  footnote,
}: {
  title: string;
  lines: readonly { accountId: string; code: string; nameAr: string; amount: string }[];
  total: string;
  currency: string;
  footnote?: { label: string; value: string; hint: string };
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
                  لا توجد أرصدة في هذا القسم
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
      {footnote !== undefined ? (
        <CardBody className="border-t border-border">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{footnote.label}</span>
            <span className="numeric font-medium">{footnote.value}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{footnote.hint}</p>
        </CardBody>
      ) : null}
    </Card>
  );
}

function Pair({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="numeric font-medium">{value}</dd>
    </div>
  );
}
