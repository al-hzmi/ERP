'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, ArrowRight, Printer, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ZATCA_STATUS, INVOICE_TYPE_LABELS } from '@/lib/commercial/zatca-labels';
import type { InvoiceDetail } from '@/lib/application/services/invoice-detail-service';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatDate, formatMoney, statusLabel } from '@/lib/utils/format';

/**
 * One invoice: what it says, whether it posted, and what ZATCA has of it.
 *
 * ## The Post button refuses locally *and* the server refuses again
 *
 * A draft whose lines include a stock item cannot post without a warehouse — the posting use
 * case has always refused it, but the refusal arrived after the user pressed a button that
 * looked ready. So the button is disabled with the reason stated beside it. The server check
 * stays exactly where it was: this is the explanation, not the control. Any other writer still
 * meets the same refusal.
 *
 * ## Printing is CSS, not a second renderer
 *
 * `print:` utilities restyle this page rather than a separate print route. A second renderer is
 * a second thing to keep in step with the first, and the failure mode — a printed invoice whose
 * totals disagree with the screen — is the exact failure an invoice must never have.
 */
export function InvoiceDetailView({
  invoice,
  canPost,
}: {
  invoice: InvoiceDetail;
  canPost: boolean;
}): JSX.Element {
  const router = useRouter();
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const isDraft = invoice.status === 'DRAFT';
  const needsWarehouse = invoice.hasStockItems && invoice.warehouseId === null;
  const badge = statusLabel(invoice.status);

  async function post(): Promise<void> {
    setPosting(true);
    setError(null);

    const result = await apiPost<{ documentNumber: string }>(
      `/api/sales/invoices/${invoice.id}/post`,
      {},
    );

    setPosting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6 print:space-y-4">
      {/* ── Screen-only header ─────────────────────────────────────────── */}
      <header className="no-print flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/sales/invoices"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            العودة إلى السجل
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            <span className="bidi-isolate font-mono">{invoice.documentNumber}</span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {invoice.zatca !== null ? (
              <Badge tone={ZATCA_STATUS[invoice.zatca.status].tone}>
                {invoice.zatca.isSigned
                  ? ZATCA_STATUS[invoice.zatca.status].label
                  : 'غير موقَّعة إلكترونياً'}
              </Badge>
            ) : null}
          </h1>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            طباعة
          </Button>

          {isDraft && canPost ? (
            <Button type="button" onClick={post} loading={posting} disabled={needsWarehouse}>
              <Send className="h-4 w-4" aria-hidden="true" />
              ترحيل الفاتورة
            </Button>
          ) : null}
        </div>
      </header>

      {/* The reason the button is disabled, next to the button rather than after the click. */}
      {isDraft && canPost && needsWarehouse ? (
        <p
          role="alert"
          className="no-print flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            لا يمكن الترحيل قبل تحديد المستودع: الفاتورة تحتوي أصنافاً مخزنية، والترحيل يُخرجها من
            المخزون — والنظام لا يستطيع أن يقرر نيابةً عنك من أي مستودع. عدِّل الفاتورة وحدِّد
            المستودع ثم أعد المحاولة.
          </span>
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="no-print rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error.messageAr}
        </p>
      ) : null}

      {/* ── The printable document ─────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-6 print:rounded-none print:border-0 print:p-0 print:text-black">
        <div className="flex flex-wrap items-start justify-between gap-6 border-b border-border pb-5">
          <div className="flex items-start gap-4">
            {/* The company mark. An inline SVG rather than an uploaded file: the tenant has no
                logo field yet, and a broken <img> on a printed invoice is worse than a wordmark
                that always renders. It becomes an <img> the day a logo can be uploaded. */}
            <div
              aria-hidden="true"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border-2 border-foreground/80 text-xl font-bold print:border-black"
            >
              {invoice.sellerNameAr.trim().slice(0, 1)}
            </div>
            <div>
              <p className="text-lg font-semibold">{invoice.sellerNameAr}</p>
              {invoice.sellerVatNumber !== null ? (
                <p className="text-xs text-muted-foreground print:text-black">
                  الرقم الضريبي: <span className="bidi-isolate font-mono">{invoice.sellerVatNumber}</span>
                </p>
              ) : null}
              {invoice.sellerCrn !== null ? (
                <p className="text-xs text-muted-foreground print:text-black">
                  السجل التجاري: <span className="bidi-isolate font-mono">{invoice.sellerCrn}</span>
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground print:text-black">{invoice.branchNameAr}</p>
            </div>
          </div>

          <div className="text-end">
            <p className="text-base font-semibold">
              {invoice.zatca !== null
                ? (INVOICE_TYPE_LABELS[invoice.zatca.invoiceTypeCode] ?? 'فاتورة ضريبية')
                : 'فاتورة ضريبية'}
            </p>
            <p className="bidi-isolate font-mono text-sm">{invoice.documentNumber}</p>
            <p className="text-xs text-muted-foreground print:text-black">
              تاريخ الإصدار: {formatDate(invoice.issueDate, { calendar: 'gregorian', style: 'medium' })}
            </p>
            <p className="text-xs text-muted-foreground print:text-black">
              تاريخ الاستحقاق: {formatDate(invoice.dueDate, { calendar: 'gregorian', style: 'medium' })}
            </p>
          </div>
        </div>

        <div className="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground print:text-black">فاتورة إلى</p>
            <p className="font-medium">{invoice.customerNameAr}</p>
            <p className="bidi-isolate text-xs text-muted-foreground print:text-black">
              {invoice.customerCode}
            </p>
            {invoice.customerVatNumber !== null ? (
              <p className="text-xs text-muted-foreground print:text-black">
                الرقم الضريبي:{' '}
                <span className="bidi-isolate font-mono">{invoice.customerVatNumber}</span>
              </p>
            ) : null}
            {invoice.customerAddress !== null ? (
              <p className="text-xs text-muted-foreground print:text-black">
                {invoice.customerAddress}
              </p>
            ) : null}
          </div>

          {/* The QR sits with the header on paper, which is where a cashier looks for it. */}
          {invoice.zatca !== null && invoice.zatca.qrPath !== '' ? (
            <div className="flex justify-end">
              <figure className="text-center">
                <svg
                  viewBox={`0 0 ${invoice.zatca.qrExtent} ${invoice.zatca.qrExtent}`}
                  className="h-32 w-32"
                  role="img"
                  aria-label="رمز الاستجابة السريعة للفاتورة الإلكترونية"
                  shapeRendering="crispEdges"
                >
                  <rect width="100%" height="100%" fill="#fff" />
                  <path d={invoice.zatca.qrPath} fill="#000" />
                </svg>
                <figcaption className="mt-1 text-[10px] text-muted-foreground print:text-black">
                  رمز الفاتورة الإلكترونية (ZATCA)
                </figcaption>
              </figure>
            </div>
          ) : null}
        </div>

        <table className="data-table mt-4 print:text-[11px]">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">الصنف</th>
              <th scope="col" className="numeric">الكمية</th>
              <th scope="col" className="numeric">سعر الوحدة</th>
              <th scope="col" className="numeric">الخصم</th>
              <th scope="col" className="numeric">الضريبة</th>
              <th scope="col" className="numeric">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.lineNumber}>
                <td className="numeric text-muted-foreground print:text-black">{line.lineNumber}</td>
                <td>
                  <p>{line.productNameAr}</p>
                  <p className="bidi-isolate text-[11px] text-muted-foreground print:text-black">
                    {line.productSku}
                  </p>
                </td>
                <td className="numeric">{Number(line.quantity).toLocaleString('en-US')}</td>
                <td className="numeric">
                  {formatMoney(line.unitPrice, { currency: invoice.currency, showCurrency: false })}
                </td>
                <td className="numeric">
                  {formatMoney(line.discount, { currency: invoice.currency, showCurrency: false })}
                </td>
                <td className="numeric">
                  {formatMoney(line.taxAmount, { currency: invoice.currency, showCurrency: false })}
                  <span className="ms-1 text-[10px] text-muted-foreground print:text-black">
                    ({line.taxRate}%)
                  </span>
                </td>
                <td className="numeric font-medium">
                  {formatMoney(line.lineTotal, { currency: invoice.currency, showCurrency: false })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 flex justify-end">
          <dl className="w-full max-w-xs space-y-1.5 text-sm">
            <Row label="الإجمالي قبل الضريبة" value={formatMoney(invoice.subtotal, { currency: invoice.currency })} />
            {Number(invoice.discountTotal) > 0 ? (
              <Row label="الخصم" value={formatMoney(invoice.discountTotal, { currency: invoice.currency })} />
            ) : null}
            <Row label="ضريبة القيمة المضافة" value={formatMoney(invoice.taxTotal, { currency: invoice.currency })} />
            <div className="flex items-center justify-between border-t border-border pt-1.5 text-base font-semibold">
              <dt>الإجمالي شامل الضريبة</dt>
              <dd className="numeric">{formatMoney(invoice.total, { currency: invoice.currency })}</dd>
            </div>
            {Number(invoice.paidAmount) > 0 ? (
              <>
                <Row label="المسدد" value={formatMoney(invoice.paidAmount, { currency: invoice.currency })} />
                <Row label="المتبقي" value={formatMoney(invoice.outstanding, { currency: invoice.currency })} />
              </>
            ) : null}
          </dl>
        </div>

        {invoice.notes !== null && invoice.notes !== '' ? (
          <p className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground print:text-black">
            {invoice.notes}
          </p>
        ) : null}

        {invoice.zatca !== null ? (
          <p className="mt-5 border-t border-border pt-4 text-[10px] text-muted-foreground print:text-black">
            عدّاد الفاتورة الإلكترونية (ICV):{' '}
            <span className="bidi-isolate font-mono">{invoice.zatca.icv}</span> — المعرِّف:{' '}
            <span className="bidi-isolate font-mono">{invoice.zatca.invoiceUuid}</span>
          </p>
        ) : null}
      </div>

      {/* ── Screen-only: the accounting behind it ───────────────────────── */}
      {invoice.journalLines.length > 0 ? (
        <Card className="no-print">
          <CardHeader
            title="القيد المحاسبي"
            description={`تولَّد آلياً عند الترحيل — ${invoice.journalNumber ?? ''}`}
          />
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">الحساب</th>
                  <th scope="col" className="numeric">مدين</th>
                  <th scope="col" className="numeric">دائن</th>
                </tr>
              </thead>
              <tbody>
                {invoice.journalLines.map((line, index) => (
                  <tr key={`${line.accountCode}-${index}`}>
                    <td>
                      <span className="bidi-isolate font-mono text-xs">{line.accountCode}</span>
                      <span className="ms-2">{line.accountNameAr}</span>
                    </td>
                    <td className="numeric">
                      {Number(line.debit) > 0
                        ? formatMoney(line.debit, { currency: invoice.currency, showCurrency: false })
                        : '—'}
                    </td>
                    <td className="numeric">
                      {Number(line.credit) > 0
                        ? formatMoney(line.credit, { currency: invoice.currency, showCurrency: false })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : isDraft ? (
        <Card className="no-print">
          <CardBody className="text-sm text-muted-foreground">
            لم يُنشأ قيد محاسبي بعد. المسودة لا تُرحَّل ولا تمس الأستاذ العام — الترحيل هو ما
            يُنشئ القيد ويُخرج البضاعة من المخزون ويُصدر الفاتورة الإلكترونية.
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground print:text-black">{label}</dt>
      <dd className="numeric">{value}</dd>
    </div>
  );
}
