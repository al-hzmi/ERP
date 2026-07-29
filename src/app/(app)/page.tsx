import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Boxes,
  Clock,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getDashboardMetrics } from '@/lib/application/services/report-service';
import { getRequestContext } from '@/lib/infrastructure/auth/request-context';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney, formatQuantity } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'لوحة المعلومات' };

/**
 * The dashboard.
 *
 * A server component that queries directly rather than fetching its own API:
 * the data is needed to render, the render happens on the server, and a round
 * trip through HTTP to reach the same database would add latency and nothing
 * else. Everything below is read-only, so there is no mutation path to protect.
 */
export default async function DashboardPage(): Promise<JSX.Element> {
  const context = await getRequestContext();
  if (!context.ok) return <p>غير مصرح.</p>;

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: context.value.tenantId },
    select: { functionalCurrency: true, nameAr: true },
  });

  const metrics = await getDashboardMetrics(context.value.tenantId, tenant.functionalCurrency);
  const currency = tenant.functionalCurrency;

  const growth = metrics.revenueGrowthPercent;
  const growthIsPositive = growth !== null && !growth.startsWith('-');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">لوحة المعلومات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          نظرة عامة على الأداء المالي والتشغيلي — {tenant.nameAr}
        </p>
      </header>

      {/* ── Headline metrics ────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="إيرادات الشهر"
          value={formatMoney(metrics.revenueThisMonth, { currency, compact: true })}
          icon={<TrendingUp className="h-5 w-5" aria-hidden="true" />}
          tone="primary"
          footer={
            growth === null ? (
              <span className="text-muted-foreground">لا توجد بيانات مقارنة</span>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1',
                  growthIsPositive ? 'text-success' : 'text-destructive',
                )}
              >
                {growthIsPositive ? (
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span className="numeric">{growth}%</span>
                <span className="text-muted-foreground">مقارنة بالشهر السابق</span>
              </span>
            )
          }
        />

        <MetricTile
          label="مجمل الربح"
          value={formatMoney(metrics.grossMargin, { currency, compact: true })}
          icon={<Wallet className="h-5 w-5" aria-hidden="true" />}
          tone="success"
          footer={
            metrics.grossMarginPercent === null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className="text-muted-foreground">
                هامش <span className="numeric">{metrics.grossMarginPercent}%</span> من الإيرادات
              </span>
            )
          }
        />

        <MetricTile
          label="ذمم العملاء"
          value={formatMoney(metrics.receivablesOutstanding, { currency, compact: true })}
          icon={<Banknote className="h-5 w-5" aria-hidden="true" />}
          tone="warning"
          footer={
            <span className="text-muted-foreground">
              منها{' '}
              <span className="numeric text-destructive">
                {formatMoney(metrics.overdueReceivables, { currency, compact: true })}
              </span>{' '}
              متأخرة
            </span>
          }
        />

        <MetricTile
          label="قيمة المخزون"
          value={formatMoney(metrics.inventoryValue, { currency, compact: true })}
          icon={<Boxes className="h-5 w-5" aria-hidden="true" />}
          tone="neutral"
          footer={
            <span className="text-muted-foreground">
              <span className="numeric">{metrics.productsBelowReorder}</span> صنف تحت حد إعادة الطلب
            </span>
          }
        />
      </div>

      {/* ── Attention required ──────────────────────────────────────────── */}
      {metrics.documentsAwaitingApproval > 0 || metrics.expiringBatchesCount > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {metrics.documentsAwaitingApproval > 0 ? (
            <AlertRow
              icon={<Clock className="h-4 w-4" aria-hidden="true" />}
              tone="warning"
              title={`${metrics.documentsAwaitingApproval} مستند بانتظار الاعتماد`}
              description="لن تُرحّل هذه المستندات حتى يعتمدها مستخدم مخوّل."
            />
          ) : null}
          {metrics.expiringBatchesCount > 0 ? (
            <AlertRow
              icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
              tone="danger"
              title={`${metrics.expiringBatchesCount} دفعة تنتهي صلاحيتها خلال 90 يوماً`}
              description="راجع تقرير الصلاحية قبل أن تتحول إلى خسارة مخزنية."
            />
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        {/* ── Revenue trend ─────────────────────────────────────────────── */}
        <Card className="xl:col-span-2">
          <CardHeader
            title="الإيرادات وتكلفة المبيعات"
            description="آخر اثني عشر شهراً، بالريال السعودي"
          />
          <CardBody>
            <RevenueBars data={metrics.revenueByMonth} currency={currency} />
          </CardBody>
        </Card>

        {/* ── Cash and payables ─────────────────────────────────────────── */}
        <Card>
          <CardHeader title="المركز النقدي" />
          <CardBody className="space-y-4">
            <SummaryRow
              label="النقدية والبنوك"
              value={formatMoney(metrics.cashPosition, { currency })}
              tone="success"
            />
            <SummaryRow
              label="ذمم الموردين"
              value={formatMoney(metrics.payablesOutstanding, { currency })}
              tone="danger"
            />
            <SummaryRow
              label="ذمم العملاء"
              value={formatMoney(metrics.receivablesOutstanding, { currency })}
              tone="neutral"
            />
            <div className="border-t border-border pt-4">
              <SummaryRow
                label="صافي رأس المال العامل"
                value={formatMoney(
                  netWorkingCapital(
                    metrics.cashPosition,
                    metrics.receivablesOutstanding,
                    metrics.payablesOutstanding,
                  ),
                  { currency },
                )}
                tone="primary"
                emphasis
              />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ── Top products ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="الأصناف الأعلى مبيعاً"
          description="مرتبة حسب صافي الإيراد خلال آخر اثني عشر شهراً"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="w-16">#</th>
                <th scope="col">رمز الصنف</th>
                <th scope="col">اسم الصنف</th>
                <th scope="col" className="numeric">الكمية المباعة</th>
                <th scope="col" className="numeric">صافي الإيراد</th>
              </tr>
            </thead>
            <tbody>
              {metrics.topProducts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-muted-foreground">
                    لا توجد مبيعات مسجلة بعد
                  </td>
                </tr>
              ) : (
                metrics.topProducts.map((product, index) => (
                  <tr key={product.sku}>
                    <td className="numeric text-muted-foreground">{index + 1}</td>
                    <td>
                      <span className="bidi-isolate font-mono text-xs text-primary">
                        {product.sku}
                      </span>
                    </td>
                    <td className="max-w-xs truncate">{product.nameAr}</td>
                    <td className="numeric">{formatQuantity(product.quantity)}</td>
                    <td className="numeric font-medium">
                      {formatMoney(product.revenue, { currency, showCurrency: false })}
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

/**
 * Working capital, computed on decimal strings.
 *
 * Doing this with `parseFloat` would be simpler and would quietly lose halalas
 * on a nine-figure balance sheet.
 */
function netWorkingCapital(cash: string, receivables: string, payables: string): string {
  const toHalalas = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
    const sign = value.startsWith('-') ? -1n : 1n;
    return sign * BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
  };

  const total = toHalalas(cash) + toHalalas(receivables) - toHalalas(payables);
  const negative = total < 0n;
  const absolute = (negative ? -total : total).toString().padStart(3, '0');

  return `${negative ? '-' : ''}${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
}

function MetricTile({
  label,
  value,
  icon,
  footer,
  tone,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  footer: ReactNode;
  tone: 'primary' | 'success' | 'warning' | 'neutral';
}): JSX.Element {
  const tones: Record<typeof tone, string> = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    neutral: 'bg-muted text-muted-foreground',
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="numeric mt-2 text-2xl font-semibold tracking-tight">{value}</p>
        </div>
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg', tones[tone])}>
          {icon}
        </span>
      </div>
      <p className="mt-3 text-xs">{footer}</p>
    </Card>
  );
}

function SummaryRow({
  label,
  value,
  tone,
  emphasis = false,
}: {
  label: string;
  value: string;
  tone: 'primary' | 'success' | 'danger' | 'neutral';
  emphasis?: boolean;
}): JSX.Element {
  const tones: Record<typeof tone, string> = {
    primary: 'text-primary',
    success: 'text-success',
    danger: 'text-destructive',
    neutral: 'text-foreground',
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn('text-sm', emphasis ? 'font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className={cn('numeric text-sm font-semibold', tones[tone])}>{value}</span>
    </div>
  );
}

/**
 * A CSS-only bar chart.
 *
 * A charting library would be 40 KB of JavaScript to draw twelve rectangles, and
 * would need to be a client component. Bars scale against the largest value in
 * the series, so the shape is readable whatever the absolute numbers are.
 */
function RevenueBars({
  data,
  currency,
}: {
  data: readonly { month: string; revenue: string; cogs: string }[];
  currency: string;
}): JSX.Element {
  if (data.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">لا توجد بيانات بعد</p>;
  }

  const magnitudes = data.map((point) => Number.parseFloat(point.revenue) || 0);
  const peak = Math.max(...magnitudes, 1);

  return (
    <div className="flex h-56 items-end justify-between gap-2" role="img" aria-label="مخطط الإيرادات الشهرية">
      {data.map((point) => {
        const revenue = Number.parseFloat(point.revenue) || 0;
        const cogs = Number.parseFloat(point.cogs) || 0;
        const revenueHeight = Math.max(2, (revenue / peak) * 100);
        const cogsHeight = Math.max(0, (cogs / peak) * 100);

        return (
          // `h-full` on the bar's wrapper only resolves if every ancestor up to
          // the fixed-height track also has a definite height — otherwise the
          // percentage is measured against `auto` and every bar collapses to zero.
          <div key={point.month} className="group flex h-full min-w-0 flex-1 flex-col items-center gap-2">
            <div className="relative flex min-h-0 w-full flex-1 items-end justify-center">
              <div
                className="w-full max-w-10 rounded-t bg-primary/85 transition-all group-hover:bg-primary"
                style={{ height: `${revenueHeight}%` }}
              />
              <div
                className="absolute bottom-0 w-full max-w-10 rounded-t bg-primary/25"
                style={{ height: `${cogsHeight}%` }}
                aria-hidden="true"
              />
              <span className="pointer-events-none absolute -top-1 hidden -translate-y-full whitespace-nowrap rounded bg-popover px-2 py-1 text-[11px] shadow-lg ring-1 ring-border group-hover:block">
                {formatMoney(point.revenue, { currency, compact: true })}
              </span>
            </div>
            <span className="numeric truncate text-[10px] text-muted-foreground">
              {point.month.slice(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AlertRow({
  icon,
  title,
  description,
  tone,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  tone: 'warning' | 'danger';
}): JSX.Element {
  return (
    <Card className="flex items-start gap-3 p-4">
      <Badge tone={tone} className="mt-0.5 shrink-0">
        {icon}
      </Badge>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </Card>
  );
}
