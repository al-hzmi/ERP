import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { getStatementOfAccount } from '@/lib/application/services/collections-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'كشف حساب' };

/**
 * A statement of account, ready to send.
 *
 * Print-first: the page is laid out so that `Ctrl+P` produces the sheet a customer receives.
 * The sidebar and header carry `no-print` already, and nothing here is behind an interaction —
 * a statement that needs a button pressed before it renders is one that prints half-empty.
 *
 * **The closing balance and the ageing total are the same number, computed once.** They sit
 * side by side on the sheet, and a customer who finds them differing by a fils stops reading
 * the rest and starts an argument nobody can settle. `getStatementOfAccount` accumulates the
 * running balance in `bigint` and ages the same open items, so they cannot disagree.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { from?: string; to?: string };
}): Promise<JSX.Element> {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.to ?? '')
    ? (searchParams.to as string)
    : new Date().toISOString().slice(0, 10);

  // A statement defaults to a year, which is the window a customer can reconcile against their
  // own ledger. Everything older is folded into the opening balance rather than dropped.
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.from ?? '')
    ? (searchParams.from as string)
    : `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`;

  const { statement, currency, tenantName } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true, nameAr: true },
    });

    return {
      statement: await getStatementOfAccount({
        tenantId: context.tenantId,
        counterpartyId: params.id,
        fromDate: new Date(`${fromDate}T00:00:00.000Z`),
        asOf: new Date(`${asOf}T00:00:00.000Z`),
      }),
      currency: tenant.functionalCurrency,
      tenantName: tenant.nameAr,
    };
  });

  if (!statement.ok) notFound();
  const sheet = statement.value;

  return (
    <div className="space-y-6">
      <header className="no-print flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">كشف حساب</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {sheet.nameAr} — من {fromDate} إلى {asOf}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/sales/customers/${params.id}`}
            className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent"
          >
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            بطاقة العميل
          </Link>
          {/* A hint, not a button. Triggering `window.print()` needs a client component, and
              adding a client boundary to a page whose entire job is to be printed would ship
              React for one keystroke the browser already provides. */}
          <span className="hidden items-center gap-1.5 rounded-md border border-dashed border-input px-3 py-1.5 text-sm text-muted-foreground md:flex">
            <Printer className="h-4 w-4" aria-hidden="true" />
            للطباعة: Ctrl+P
          </span>
        </div>
      </header>

      <Card>
        <CardBody className="space-y-1">
          <p className="text-lg font-semibold">{tenantName}</p>
          <p className="text-sm text-muted-foreground">
            كشف حساب: <span className="font-medium text-foreground">{sheet.nameAr}</span>
            <span className="bidi-isolate"> ({sheet.code})</span>
          </p>
          {sheet.phone !== null || sheet.email !== null ? (
            <p className="bidi-isolate text-xs text-muted-foreground">
              {[sheet.phone, sheet.email].filter((value) => value !== null).join(' · ')}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            كما في {asOf}
            {sheet.graceDays > 0 ? ` — فترة سماح ${sheet.graceDays} يوماً` : ''}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="الحركة"
          description={`الرصيد الافتتاحي ${formatMoney(sheet.openingBalance, { currency })} — ${sheet.lines.length} حركة خلال الفترة`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">التاريخ</th>
                <th scope="col">المرجع</th>
                <th scope="col">البيان</th>
                <th scope="col">الاستحقاق</th>
                <th scope="col" className="numeric">
                  مدين
                </th>
                <th scope="col" className="numeric">
                  دائن
                </th>
                <th scope="col" className="numeric">
                  الرصيد
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-muted/30">
                <td colSpan={6} className="text-xs font-medium">
                  رصيد ما قبل {fromDate}
                </td>
                <td className="numeric font-medium">
                  {formatMoney(sheet.openingBalance, { currency })}
                </td>
              </tr>

              {sheet.lines.map((line) => (
                <tr key={`${line.reference}-${line.date}`}>
                  <td className="bidi-isolate font-mono text-xs">{line.date}</td>
                  <td className="bidi-isolate font-mono text-xs text-primary">{line.reference}</td>
                  <td className="text-xs">{line.kindAr}</td>
                  <td className="bidi-isolate font-mono text-xs text-muted-foreground">
                    {line.dueDate ?? '—'}
                    {line.overdueDays !== null ? (
                      <Badge tone="danger" className="ms-1.5">
                        {line.overdueDays} يوم
                      </Badge>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {Number(line.debit) === 0 ? '—' : formatMoney(line.debit, { currency })}
                  </td>
                  <td className="numeric">
                    {Number(line.credit) === 0 ? '—' : formatMoney(line.credit, { currency })}
                  </td>
                  <td className="numeric font-medium">
                    {formatMoney(line.balance, { currency })}
                  </td>
                </tr>
              ))}

              <tr className="border-t-2 border-border bg-muted/40">
                <td colSpan={6} className="font-semibold">
                  الرصيد المستحق كما في {asOf}
                </td>
                <td className="numeric text-base font-semibold">
                  {formatMoney(sheet.closingBalance, { currency })}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="أعمار المتأخرات"
          description="الأرقام نفسها التي تُقيَّم عند إصدار أمر بيع جديد لهذا العميل"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="numeric">غير مستحق</th>
                <th scope="col" className="numeric">1 — 30</th>
                <th scope="col" className="numeric">31 — 60</th>
                <th scope="col" className="numeric">61 — 90</th>
                <th scope="col" className="numeric">أكثر من 90</th>
                <th scope="col" className="numeric">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="numeric text-muted-foreground">
                  {formatMoney(sheet.aging.current, { currency })}
                </td>
                <td className="numeric">{formatMoney(sheet.aging.days1to30, { currency })}</td>
                <td className="numeric">{formatMoney(sheet.aging.days31to60, { currency })}</td>
                <td className="numeric text-destructive">
                  {formatMoney(sheet.aging.days61to90, { currency })}
                </td>
                <td className="numeric font-semibold text-destructive">
                  {formatMoney(sheet.aging.over90, { currency })}
                </td>
                <td className="numeric font-semibold">
                  {formatMoney(sheet.aging.total, { currency })}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {sheet.oldestOverdueDays > 0 ? (
          <CardBody className="border-t border-border text-sm">
            <span className="font-medium text-destructive">
              أقدم مبلغ متأخر منذ {sheet.oldestOverdueDays} يوماً.
            </span>{' '}
            <span className="text-muted-foreground">
              نرجو السداد أو التواصل لجدولة الرصيد.
            </span>
          </CardBody>
        ) : null}
      </Card>
    </div>
  );
}
