'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FileCode2, QrCode, Send, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  INVOICE_TYPE_LABELS,
  ZATCA_STATUS,
  type ZatcaStatus,
} from '@/lib/commercial/zatca-labels';
import { apiPost, type ApiError } from '@/lib/utils/api-client';

/**
 * The e-invoice preview: status, decoded QR, and the XML.
 *
 * ## The QR is decoded server-side, not rendered as an image
 *
 * What a user needs from a QR code on a screen is not the picture — their phone is not going to
 * scan their own monitor — it is *what the picture says*. So the panel shows the decoded TLV
 * fields in words. The Base64 payload is there too, one copy away, for anyone who does need to
 * render it. Pulling in a QR image library to draw something nobody scans would be weight for
 * no purpose.
 *
 * Tags 7–9 are DER, so they are shown as byte counts. Rendering them as text produces mojibake
 * and implies the data is broken when it is fine.
 */

export interface ZatcaPanelInvoice {
  readonly id: string;
  readonly documentNumber: string;
  readonly invoiceUuid: string;
  readonly icv: string;
  readonly status: ZatcaStatus;
  readonly invoiceTypeCode: string;
  readonly invoiceHash: string;
  readonly previousHash: string;
  readonly qrCode: string;
  readonly xml: string;
  readonly isSigned: boolean;
  readonly issuedAtUtc: string;
  readonly submittedAt: string | null;
  readonly attemptCount: number;
  readonly warningCount: number;
  readonly qrFields: readonly { tag: number; labelAr: string; value: string }[];
  readonly responseJson: unknown;
}

export function ZatcaStatusBadge({
  status,
  isSigned,
}: {
  status: ZatcaStatus;
  isSigned: boolean;
}): JSX.Element {
  const presentation = ZATCA_STATUS[status];

  // An unsigned invoice is shown as unsigned even while its status reads PENDING, because
  // "بانتظار الإرسال" implies it is ready to send and it is not.
  if (!isSigned && status === 'PENDING') {
    return <Badge tone="neutral">غير موقَّعة</Badge>;
  }

  return <Badge tone={presentation.tone}>{presentation.label}</Badge>;
}

export function ZatcaPanel({
  invoice,
  canSubmit,
  onClose,
}: {
  invoice: ZatcaPanelInvoice;
  canSubmit: boolean;
  onClose: () => void;
}): JSX.Element {
  const router = useRouter();
  const [tab, setTab] = useState<'qr' | 'xml'>('qr');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const presentation = ZATCA_STATUS[invoice.status];
  const submittable =
    canSubmit && invoice.isSigned && (invoice.status === 'PENDING' || invoice.status === 'FAILED');

  async function submit(): Promise<void> {
    setSending(true);
    setError(null);
    setMessage(null);

    const result = await apiPost<{ status: string; messageAr: string; warningCount: number }>(
      '/api/system/zatca/submit',
      { zatcaInvoiceId: invoice.id },
    );

    setSending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setMessage(result.data.messageAr);
    router.refresh();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm duration-150 animate-in fade-in sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`الفاتورة الإلكترونية ${invoice.documentNumber}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-2xl duration-200 animate-in zoom-in-95 slide-in-from-bottom-2">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              الفاتورة الإلكترونية
              <span className="bidi-isolate font-mono text-xs text-muted-foreground">
                {invoice.documentNumber}
              </span>
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{presentation.meaning}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <dl className="grid gap-x-6 gap-y-2 border-b border-border px-5 py-4 text-sm sm:grid-cols-2">
          <Row label="الحالة">
            <ZatcaStatusBadge status={invoice.status} isSigned={invoice.isSigned} />
          </Row>
          <Row label="النوع">
            <span>{INVOICE_TYPE_LABELS[invoice.invoiceTypeCode] ?? invoice.invoiceTypeCode}</span>
          </Row>
          <Row label="عدّاد الفاتورة (ICV)">
            <span className="numeric">{invoice.icv}</span>
          </Row>
          <Row label="معرِّف الفاتورة (UUID)">
            <span dir="ltr" className="truncate font-mono text-xs">
              {invoice.invoiceUuid}
            </span>
          </Row>
          <Row label="بصمة الفاتورة">
            <span dir="ltr" className="truncate font-mono text-xs">
              {invoice.invoiceHash.slice(0, 24)}…
            </span>
          </Row>
          <Row label="بصمة الفاتورة السابقة (PIH)">
            <span dir="ltr" className="truncate font-mono text-xs">
              {invoice.previousHash.slice(0, 24)}…
            </span>
          </Row>
          {invoice.submittedAt !== null ? (
            <Row label="أُرسلت في">
              <span dir="ltr" className="font-mono text-xs">
                {invoice.submittedAt.slice(0, 19).replace('T', ' ')}
              </span>
            </Row>
          ) : null}
          {invoice.attemptCount > 0 ? (
            <Row label="عدد المحاولات">
              <span className="numeric">{invoice.attemptCount}</span>
            </Row>
          ) : null}
        </dl>

        {!invoice.isSigned ? (
          <p className="border-b border-border bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
            هذه الفاتورة غير موقَّعة إلكترونياً — أُصدرت قبل تركيب شهادة الختم التشفيري (CSID).
            رمز QR يحمل ستة وسوم بدل تسعة، ولا يمكن إرسالها إلى الهيئة. الفواتير الصادرة بعد
            التفعيل تُوقَّع تلقائياً.
          </p>
        ) : null}

        <nav className="flex gap-1 border-b border-border px-5 pt-3" aria-label="طريقة العرض">
          <TabButton active={tab === 'qr'} onClick={() => setTab('qr')}>
            <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
            رمز الاستجابة السريعة
          </TabButton>
          <TabButton active={tab === 'xml'} onClick={() => setTab('xml')}>
            <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
            ملف UBL 2.1
          </TabButton>
        </nav>

        <div className="px-5 py-4">
          {tab === 'qr' ? (
            <div className="space-y-3">
              <table className="data-table text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="w-12">الوسم</th>
                    <th scope="col">الحقل</th>
                    <th scope="col">القيمة</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.qrFields.map((field) => (
                    <tr key={field.tag}>
                      <td className="numeric text-muted-foreground">{field.tag}</td>
                      <td>{field.labelAr}</td>
                      <td className="max-w-[18rem] truncate font-mono text-xs" dir="ltr">
                        {field.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <details className="rounded-md border border-border">
                <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
                  الحمولة الخام (Base64)
                </summary>
                <pre
                  dir="ltr"
                  className="max-h-40 overflow-auto break-all whitespace-pre-wrap border-t border-border p-3 font-mono text-[11px]"
                >
                  {invoice.qrCode}
                </pre>
              </details>
            </div>
          ) : (
            <pre
              dir="ltr"
              className="max-h-[28rem] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed"
            >
              {invoice.xml}
            </pre>
          )}
        </div>

        {invoice.responseJson !== null && invoice.responseJson !== undefined ? (
          <details className="border-t border-border px-5 py-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              سجل استجابة الهيئة
              {invoice.warningCount > 0 ? ` — ${invoice.warningCount} ملاحظة` : ''}
            </summary>
            <pre
              dir="ltr"
              className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-[11px]"
            >
              {JSON.stringify(invoice.responseJson, null, 2)}
            </pre>
          </details>
        ) : null}

        {error !== null ? (
          <p className="mx-5 mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error.messageAr}
          </p>
        ) : null}

        {message !== null ? (
          <p className="mx-5 mb-3 rounded-md border border-success/30 bg-success/5 p-3 text-sm text-success">
            {message}
          </p>
        ) : null}

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            صدرت في{' '}
            <span dir="ltr" className="font-mono">
              {invoice.issuedAtUtc.slice(0, 19).replace('T', ' ')} UTC
            </span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              إغلاق
            </Button>
            {submittable ? (
              <Button onClick={submit} disabled={sending}>
                <Send className="h-4 w-4" aria-hidden="true" />
                {sending ? 'جارٍ الإرسال…' : 'إرسال إلى الهيئة'}
              </Button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 py-1.5 last:border-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-xs font-medium'
          : 'flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground hover:text-foreground'
      }
    >
      {children}
    </button>
  );
}
