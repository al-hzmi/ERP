import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatDate, formatMoney } from '@/lib/utils/format';
import type { CounterpartyCard as CardData } from '@/lib/application/services/counterparty-service';

/**
 * The customer / supplier card.
 *
 * Built around the ageing strip, because that is the one thing a credit controller looks at
 * and everything else on the page is context for it. Five buckets by days *past due*, not days
 * since issue — a 60-day invoice issued 45 days ago is current, and an ageing report that
 * counted from issue would show it as overdue and start a collection call on a customer who
 * owes nothing yet.
 *
 * **The buckets are computed in SQL and arrive as strings.** They are never parsed into a
 * JavaScript number on the way here, which is the same rule the rest of the money path
 * follows: the figure a controller acts on is the figure PostgreSQL summed.
 *
 * Document numbers are text, not links. There is no document detail screen yet, and a link
 * that 404s is worse than no link — the same rule the registers follow.
 */

const DOCUMENT_LABELS: Record<string, string> = {
  SALES_INVOICE: 'فاتورة مبيعات',
  SALES_CREDIT_NOTE: 'إشعار دائن',
  PURCHASE_INVOICE: 'فاتورة مشتريات',
  PURCHASE_DEBIT_NOTE: 'إشعار مدين',
};

const PAYMENT_LABELS: Record<string, string> = { RECEIPT: 'قبض', PAYMENT: 'صرف' };

const METHOD_LABELS: Record<string, string> = {
  CASH: 'نقداً',
  BANK: 'تحويل',
  CHECK: 'شيك',
  CARD: 'بطاقة',
};

export function CounterpartyCardView({
  data,
  kind,
  basePath,
  canSeeCredit,
}: {
  data: CardData;
  kind: 'CUSTOMER' | 'SUPPLIER';
  basePath: string;
  canSeeCredit: boolean;
}): JSX.Element {
  const { counterparty, ageing, openDocuments, recentPayments } = data;
  const currency = counterparty.currency;
  const isCustomer = kind === 'CUSTOMER';

  const buckets = [
    { label: 'غير مستحق', value: ageing.current, tone: 'neutral' as const },
    { label: '1–30 يوم', value: ageing.days30, tone: 'neutral' as const },
    { label: '31–60 يوم', value: ageing.days60, tone: 'warning' as const },
    { label: '61–90 يوم', value: ageing.days90, tone: 'warning' as const },
    { label: 'أكثر من 90', value: ageing.over90, tone: 'danger' as const },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={basePath}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          {isCustomer ? 'عودة إلى العملاء' : 'عودة إلى الموردين'}
        </Link>
      </div>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{counterparty.nameAr}</h1>
          <Badge tone={counterparty.classification === 'A' ? 'success' : 'neutral'}>
            الفئة {counterparty.classification}
          </Badge>
          {!counterparty.isActive ? <Badge tone="neutral">موقوف</Badge> : null}
          {counterparty.type === 'BOTH' ? <Badge tone="info">عميل ومورد</Badge> : null}
        </div>
        <p className="bidi-isolate mt-1 font-mono text-sm text-muted-foreground">
          {counterparty.code}
        </p>
      </header>

      {/* The ageing strip: the whole reason this page exists. */}
      <Card>
        <CardHeader
          title={isCustomer ? 'أعمار الذمم المدينة' : 'أعمار الذمم الدائنة'}
          description="الاحتساب من تاريخ الاستحقاق لا من تاريخ الإصدار"
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {buckets.map((bucket) => (
              <div
                key={bucket.label}
                className={
                  bucket.tone === 'danger'
                    ? 'rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5'
                    : bucket.tone === 'warning'
                      ? 'rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5'
                      : 'rounded-lg border border-border px-3 py-2.5'
                }
              >
                <p className="text-[11px] text-muted-foreground">{bucket.label}</p>
                <p className="numeric mt-1 text-lg font-semibold">
                  {formatMoney(bucket.value, { currency, showCurrency: false })}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">
              إجمالي المستحق ({openDocuments.length} مستند مفتوح)
            </span>
            <span className="numeric text-lg font-semibold">
              {formatMoney(ageing.total, { currency })}
            </span>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="البيانات" />
          <CardBody>
            <dl className="space-y-2.5 text-sm">
              <Row label="الاسم بالإنجليزية" value={counterparty.nameEn} isolate />
              <Row label="الهاتف" value={counterparty.phone ?? '—'} isolate />
              <Row label="البريد" value={counterparty.email ?? '—'} isolate />
              <Row label="الرقم الضريبي" value={counterparty.taxNumber ?? '—'} isolate />
              <Row label="السجل التجاري" value={counterparty.crn ?? '—'} isolate />
              <Row label="مهلة السداد" value={`${counterparty.paymentTerms} يوم`} numeric />
              <Row label="العملة" value={counterparty.currency} isolate />
              {canSeeCredit ? (
                <Row
                  label="حد الائتمان"
                  value={formatMoney(counterparty.creditLimit, { currency })}
                  numeric
                />
              ) : (
                <Row label="حد الائتمان" value="محجوب — يتطلب صلاحية حقلية" />
              )}
              <Row
                label="الرصيد الدفتري"
                value={formatMoney(counterparty.balance, { currency })}
                numeric
              />
            </dl>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="المستندات المفتوحة"
            description="مرتّبة بتاريخ الاستحقاق — الأقدم أولاً"
          />
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">المستند</th>
                  <th scope="col">النوع</th>
                  <th scope="col">الاستحقاق</th>
                  <th scope="col" className="numeric">
                    الإجمالي
                  </th>
                  <th scope="col" className="numeric">
                    المسدد
                  </th>
                  <th scope="col" className="numeric">
                    المتبقي
                  </th>
                </tr>
              </thead>
              <tbody>
                {openDocuments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-muted-foreground">
                      لا توجد مستندات مفتوحة
                    </td>
                  </tr>
                ) : (
                  openDocuments.map((document) => (
                    <tr key={document.id}>
                      <td>
                        {/* Text, not a link: no document detail screen exists yet. */}
                        <span className="bidi-isolate font-mono text-xs font-medium text-primary">
                          {document.documentNumber}
                        </span>
                      </td>
                      <td className="text-xs text-muted-foreground">
                        {DOCUMENT_LABELS[document.type] ?? document.type}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        <span
                          className={document.overdueDays > 0 ? 'font-medium text-destructive' : undefined}
                        >
                          {formatDate(document.dueDate, { calendar: 'gregorian', style: 'medium' })}
                        </span>
                        {document.overdueDays > 0 ? (
                          <span className="numeric ms-1 text-[11px] text-destructive">
                            (+{document.overdueDays})
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric text-muted-foreground">
                        {formatMoney(document.total, {
                          currency: document.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric text-muted-foreground">
                        {formatMoney(document.paidAmount, {
                          currency: document.currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric font-medium">
                        {formatMoney(document.outstanding, {
                          currency: document.currency,
                          showCurrency: false,
                        })}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="آخر السندات" description="أحدث عشرة سندات قبض أو صرف لهذا الطرف" />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم السند</th>
                <th scope="col">النوع</th>
                <th scope="col">التاريخ</th>
                <th scope="col">الطريقة</th>
                <th scope="col" className="numeric">
                  المبلغ
                </th>
              </tr>
            </thead>
            <tbody>
              {recentPayments.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-muted-foreground">
                    لا توجد سندات مسجَّلة لهذا الطرف
                  </td>
                </tr>
              ) : (
                recentPayments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="bidi-isolate font-mono text-xs text-primary">
                      {payment.voucherNumber}
                    </td>
                    <td>
                      <Badge tone={payment.type === 'RECEIPT' ? 'success' : 'warning'}>
                        {PAYMENT_LABELS[payment.type] ?? payment.type}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {formatDate(payment.paymentDate, {
                        calendar: 'gregorian',
                        style: 'medium',
                      })}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {METHOD_LABELS[payment.method] ?? payment.method}
                    </td>
                    <td className="numeric font-medium">
                      {formatMoney(payment.amount, {
                        currency: payment.currency,
                        showCurrency: false,
                      })}
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

function Row({
  label,
  value,
  numeric = false,
  isolate = false,
}: {
  label: string;
  value: string;
  numeric?: boolean;
  isolate?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={['min-w-0 text-end', numeric ? 'numeric font-medium' : '', isolate ? 'bidi-isolate' : '']
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}
