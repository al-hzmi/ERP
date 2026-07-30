import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getAgingReport } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'أعمار الذمم' };

/**
 * Ageing, receivable and payable.
 *
 * One screen for both directions rather than two, because the report is the same computation
 * over a different set of document types and the reader's question — "who is late, and by how
 * much" — does not change with the direction.
 *
 * The bucket totals come from `getAgingReport`, which buckets in SQL: a customer with four
 * hundred open invoices costs one row of output instead of four hundred rows of transfer.
 * `creditLimit` is field-protected, so the column is dropped entirely without the grant rather
 * than blanked.
 */
export default async function AgeingPage({
  searchParams,
}: {
  searchParams: { to?: string; type?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const asOf = parseReportDate(searchParams.to, fallback.to);
  const type = searchParams.type === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE';

  const { report, currency, canSeeCredit } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    const loaded = await getAgingReport(
      context.tenantId,
      type,
      new Date(`${asOf}T00:00:00.000Z`),
      tenant.functionalCurrency,
    );

    return {
      report: loaded,
      currency: tenant.functionalCurrency,
      canSeeCredit: context.permissions.can('sales.customer', 'read', 'creditLimit'),
    };
  });

  const isReceivable = type === 'RECEIVABLE';
  const showCredit = canSeeCredit && isReceivable;
  const columns = showCredit ? 8 : 7;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isReceivable ? 'أعمار الذمم المدينة' : 'أعمار الذمم الدائنة'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          التصنيف بعدد الأيام منذ تاريخ الاستحقاق، كما في {asOf}
        </p>
      </header>

      <ReportFilters
        action="/finance/ageing"
        toDate={asOf}
        showFrom={false}
        extra={
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">الاتجاه</span>
            <select
              name="type"
              defaultValue={type}
              className="h-9 min-w-[10rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="RECEIVABLE">ذمم مدينة (عملاء)</option>
              <option value="PAYABLE">ذمم دائنة (موردون)</option>
            </select>
          </label>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Bucket label="غير مستحق" value={report.totals.current} currency={currency} />
        <Bucket label="1–30 يوم" value={report.totals.days1to30} currency={currency} />
        <Bucket label="31–60 يوم" value={report.totals.days31to60} currency={currency} tone="warning" />
        <Bucket label="61–90 يوم" value={report.totals.days61to90} currency={currency} tone="warning" />
        <Bucket label="أكثر من 90" value={report.totals.over90} currency={currency} tone="danger" />
      </div>

      <Card>
        <CardHeader
          title={isReceivable ? 'حسب العميل' : 'حسب المورد'}
          description={`الإجمالي ${formatMoney(report.totals.total, { currency })} عبر ${report.rows.length} طرفاً`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرمز</th>
                <th scope="col">الاسم</th>
                <th scope="col" className="numeric">غير مستحق</th>
                <th scope="col" className="numeric">1–30</th>
                <th scope="col" className="numeric">31–60</th>
                <th scope="col" className="numeric">61–90</th>
                <th scope="col" className="numeric">+90</th>
                <th scope="col" className="numeric">الإجمالي</th>
                {showCredit ? <th scope="col" className="numeric">حد الائتمان</th> : null}
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td colSpan={columns + 1} className="py-16 text-center text-muted-foreground">
                    لا توجد ذمم قائمة في هذا التاريخ
                  </td>
                </tr>
              ) : (
                report.rows.map((row) => (
                  <tr key={row.counterpartyId}>
                    <td>
                      <Link
                        href={
                          isReceivable
                            ? `/sales/customers/${row.counterpartyId}`
                            : `/procurement/suppliers/${row.counterpartyId}`
                        }
                        className="bidi-isolate font-mono text-xs font-medium text-primary hover:underline"
                      >
                        {row.code}
                      </Link>
                    </td>
                    <td className="max-w-[16rem] truncate">{row.nameAr}</td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.current, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric">
                      {formatMoney(row.days1to30, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric text-warning">
                      {formatMoney(row.days31to60, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric text-warning">
                      {formatMoney(row.days61to90, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric text-destructive">
                      {formatMoney(row.over90, { currency, showCurrency: false })}
                    </td>
                    <td className="numeric font-semibold">
                      {formatMoney(row.total, { currency, showCurrency: false })}
                    </td>
                    {showCredit ? (
                      <td className="numeric text-muted-foreground">
                        {formatMoney(row.creditLimit, { currency, showCurrency: false })}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Bucket({
  label,
  value,
  currency,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  currency: string;
  tone?: 'neutral' | 'warning' | 'danger';
}): JSX.Element {
  const border =
    tone === 'danger'
      ? 'border-destructive/30 bg-destructive/5'
      : tone === 'warning'
        ? 'border-warning/30 bg-warning/5'
        : 'border-border';

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${border}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="numeric mt-1 text-lg font-semibold">
        {formatMoney(value, { currency, showCurrency: false })}
      </p>
    </div>
  );
}
