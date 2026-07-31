import { Card, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getSalesByCounterparty } from '@/lib/application/services/report-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'المشتريات حسب المورد' };

/**
 * المشتريات حسب المورد.
 *
 * Credit notes net off against invoices rather than appearing as their own rows — a
 * counterparty that returned most of what it bought has not bought most of it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const fromDate = parseReportDate(searchParams.from, fallback.from);
  const toDate = parseReportDate(searchParams.to, fallback.to);

  const { rows, currency } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    return {
      rows: await getSalesByCounterparty({
        tenantId: context.tenantId,
        fromDate: new Date(`${fromDate}T00:00:00.000Z`),
        toDate: new Date(`${toDate}T00:00:00.000Z`),
        currency: tenant.functionalCurrency,
        direction: 'PURCHASES',
      }),
      currency: tenant.functionalCurrency,
    };
  });

  const total = rows.reduce((sum, row) => sum + Number(row.grossSales), 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">المشتريات حسب المورد</h1>
        <p className="mt-1 text-sm text-muted-foreground">صافي المشتريات لكل مورد بين {fromDate} و{toDate}</p>
      </header>

      <ReportFilters action="/procurement/analysis-by-supplier" fromDate={fromDate} toDate={toDate} />

      <Card>
        <CardHeader
          title="المشتريات حسب المورد"
          description={`${rows.length} جهة — الإجمالي ${formatMoney(total.toFixed(2), { currency })}`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرمز</th>
                <th scope="col">الاسم</th>
                <th scope="col" className="numeric">عدد الفواتير</th>
                <th scope="col" className="numeric">الصافي</th>
                <th scope="col" className="numeric">الضريبة</th>
                <th scope="col" className="numeric">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-muted-foreground">
                    لا توجد بيانات خلال هذه الفترة
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.counterpartyId}>
                    <td className="bidi-isolate font-mono text-xs text-primary">{row.code}</td>
                    <td className="max-w-[20rem] truncate">{row.nameAr}</td>
                    <td className="numeric text-muted-foreground">{row.invoiceCount}</td>
                    <td className="numeric">{formatMoney(row.netSales, { currency })}</td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(row.taxTotal, { currency })}
                    </td>
                    <td className="numeric font-medium">
                      {formatMoney(row.grossSales, { currency })}
                    </td>
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
