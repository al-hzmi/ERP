import Link from 'next/link';
import { AlertTriangle, Ban, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ReportFilters, defaultPeriod, parseReportDate } from '@/components/reports/report-filters';
import { withPageScope } from '@/lib/api/page';
import { getCollectionsOverview } from '@/lib/application/services/collections-service';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'لوحة التحصيل' };

/**
 * The collections dashboard.
 *
 * ## The headline is the overdue figure, not the total
 *
 * Total receivable includes everything not yet due, which is money working as intended — a
 * company with 5m outstanding and nothing overdue has a healthy book, and leading with the 5m
 * makes it look like a crisis. The number that belongs at the top is what is *late*.
 *
 * ## The buckets are ordered oldest-first
 *
 * The standard ageing report reads current → 90+, and it buries the only column anybody acts
 * on at the far end. Here 90+ comes first, because a collections screen is opened to answer
 * "what is about to become uncollectable" and the answer should not require reading past four
 * columns of good news.
 *
 * ## Every figure agrees with the credit gate
 *
 * Same grace period, same bucket boundaries, same definition of "overdue" as
 * `getCreditFacts` — which is what decides whether an order gets held. A dashboard that says a
 * customer is 70 days late while the gate lets their order through is worse than no dashboard.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { to?: string; all?: string };
}): Promise<JSX.Element> {
  const fallback = defaultPeriod();
  const asOf = parseReportDate(searchParams.to, fallback.to);
  const showAll = searchParams.all === 'true';

  const { overview, currency, canSeeCredit } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    return {
      overview: await getCollectionsOverview({
        tenantId: context.tenantId,
        asOf: new Date(`${asOf}T00:00:00.000Z`),
        overdueOnly: !showAll,
      }),
      currency: tenant.functionalCurrency,
      // The credit limit is field-protected, so the exposure columns follow it: publishing a
      // percentage *of* the limit alongside the balance discloses the limit by division.
      canSeeCredit: context.permissions.can('sales.customer', 'read', 'creditLimit'),
    };
  });

  const { totals } = overview;

  const buckets = [
    { key: 'over90', label: 'أكثر من 90 يوم', value: totals.over90, tone: 'danger' as const },
    { key: 'days61to90', label: '61 — 90 يوم', value: totals.days61to90, tone: 'danger' as const },
    { key: 'days31to60', label: '31 — 60 يوم', value: totals.days31to60, tone: 'warning' as const },
    { key: 'days1to30', label: '1 — 30 يوم', value: totals.days1to30, tone: 'warning' as const },
    { key: 'current', label: 'غير مستحق بعد', value: totals.current, tone: 'neutral' as const },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">لوحة التحصيل</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          أموال الشركة في السوق كما في {asOf} — {overview.customerCount} عميلاً عليه رصيد،
          منهم {overview.delinquentCount} متأخر و{overview.blockedCount} يُوقَف عنه البيع اليوم
        </p>
      </header>

      <ReportFilters
        action="/finance/collections"
        toDate={asOf}
        showFrom={false}
        extra={
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">العرض</span>
            <select
              name="all"
              defaultValue={showAll ? 'true' : 'false'}
              className="h-9 min-w-[12rem] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="false">المتأخرون فقط</option>
              <option value="true">كل من عليه رصيد</option>
            </select>
          </label>
        }
      />

      {/* The overdue figure, alone and large. Total receivable includes money working as
          intended; what is late is what somebody has to act on today. */}
      <Card>
        <CardBody className="border-s-4 border-s-destructive">
          <p className="text-xs text-muted-foreground">إجمالي المتأخرات</p>
          <p className="mt-1 text-3xl font-semibold text-destructive">
            {formatMoney(totals.overdue, { currency })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            من أصل {formatMoney(totals.total, { currency })} إجمالي الذمم — والباقي لم يستحق بعد
          </p>
        </CardBody>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {buckets.map((bucket) => (
          <Card key={bucket.key}>
            <CardBody>
              <p className="text-xs text-muted-foreground">{bucket.label}</p>
              <p
                className={
                  bucket.tone === 'danger'
                    ? 'mt-1 text-lg font-semibold text-destructive'
                    : bucket.tone === 'warning'
                      ? 'mt-1 text-lg font-semibold text-amber-600 dark:text-amber-500'
                      : 'mt-1 text-lg font-semibold text-muted-foreground'
                }
              >
                {formatMoney(bucket.value, { currency })}
              </p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="العملاء"
          description={
            showAll
              ? `${overview.customers.length} عميلاً عليه رصيد، مرتَّبون بأقدم المتأخرات`
              : `${overview.customers.length} عميلاً متأخراً أو موقوفاً — الإجماليات أعلاه لكل الدفتر`
          }
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">العميل</th>
                <th scope="col" className="numeric">
                  أقدم تأخير
                </th>
                <th scope="col" className="numeric">
                  أكثر من 90
                </th>
                <th scope="col" className="numeric">
                  61 — 90
                </th>
                <th scope="col" className="numeric">
                  31 — 60
                </th>
                <th scope="col" className="numeric">
                  1 — 30
                </th>
                <th scope="col" className="numeric">
                  إجمالي المتأخر
                </th>
                <th scope="col" className="numeric">
                  الرصيد
                </th>
                {canSeeCredit ? (
                  <th scope="col" className="numeric">
                    الانكشاف
                  </th>
                ) : null}
                <th scope="col">الحالة</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {overview.customers.length === 0 ? (
                <tr>
                  <td
                    colSpan={canSeeCredit ? 11 : 10}
                    className="py-16 text-center text-muted-foreground"
                  >
                    لا يوجد عميل متأخر — الدفتر نظيف كما في {asOf}
                  </td>
                </tr>
              ) : (
                overview.customers.map((customer) => (
                  <tr key={customer.counterpartyId} className={customer.wouldHold ? 'bg-destructive/5' : undefined}>
                    <td className="max-w-[18rem]">
                      <p className="truncate">{customer.nameAr}</p>
                      <p className="bidi-isolate truncate text-[11px] text-muted-foreground">
                        {customer.code}
                        {customer.phone !== null ? ` · ${customer.phone}` : ''}
                      </p>
                    </td>
                    <td className="numeric">
                      {customer.oldestOverdueDays > 0 ? (
                        <span
                          className={
                            customer.oldestOverdueDays > 90
                              ? 'font-semibold text-destructive'
                              : customer.oldestOverdueDays > 60
                                ? 'font-medium text-amber-600 dark:text-amber-500'
                                : undefined
                          }
                        >
                          {customer.oldestOverdueDays} يوم
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="numeric text-destructive">
                      {formatMoney(customer.over90, { currency })}
                    </td>
                    <td className="numeric">{formatMoney(customer.days61to90, { currency })}</td>
                    <td className="numeric">{formatMoney(customer.days31to60, { currency })}</td>
                    <td className="numeric">{formatMoney(customer.days1to30, { currency })}</td>
                    <td className="numeric font-semibold">
                      {formatMoney(customer.overdue, { currency })}
                    </td>
                    <td className="numeric text-muted-foreground">
                      {formatMoney(customer.total, { currency })}
                    </td>
                    {canSeeCredit ? (
                      <td className="numeric">
                        {customer.exposurePercent === null ? (
                          <span className="text-muted-foreground">بلا حد</span>
                        ) : (
                          <span
                            className={
                              Number(customer.exposurePercent) > 100
                                ? 'font-semibold text-destructive'
                                : 'text-muted-foreground'
                            }
                          >
                            {Number(customer.exposurePercent).toFixed(0)}%
                          </span>
                        )}
                      </td>
                    ) : null}
                    <td>
                      {customer.isBlocked ? (
                        <span title={customer.blockReason ?? undefined}>
                          <Badge tone="danger">
                            <Ban className="me-1 inline h-3 w-3" aria-hidden="true" />
                            موقوف
                          </Badge>
                        </span>
                      ) : customer.wouldHold ? (
                        <Badge tone="danger">
                          <AlertTriangle className="me-1 inline h-3 w-3" aria-hidden="true" />
                          يُوقف البيع
                        </Badge>
                      ) : customer.oldestOverdueDays > 0 ? (
                        <Badge tone="warning">متأخر</Badge>
                      ) : (
                        <Badge tone="success">منتظم</Badge>
                      )}
                    </td>
                    <td>
                      <Link
                        href={`/sales/customers/${customer.counterpartyId}/statement`}
                        className="flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
                      >
                        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                        كشف حساب
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardBody className="border-s-4 border-s-muted-foreground/30 text-sm text-muted-foreground">
          «يُوقف البيع» تعني أن أمر بيع جديد لهذا العميل سيُوقَف تلقائياً — إن كانت هناك قاعدة
          موافقة على <span className="font-medium">أقدم متأخرات العميل</span>. القاعدة تُنشأ من
          شاشة قواعد الموافقات، والأرقام هنا هي نفسها التي تُقيَّم عندها.
        </CardBody>
      </Card>
    </div>
  );
}
