'use client';

import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { ZatcaPanel, ZatcaStatusBadge, type ZatcaPanelInvoice } from './zatca-panel';
import type { ZatcaStatus } from '@/lib/commercial/zatca-labels';
import { apiGet, type ApiError } from '@/lib/utils/api-client';

/**
 * The ZATCA column in the invoice register: a badge, and a button that opens the envelope.
 *
 * The badge is rendered from data the page already loaded — a status and a boolean — so the
 * register costs one extra column and no extra query. The XML, the QR breakdown and ZATCA's
 * response are fetched only when someone actually opens the panel, because a UBL document is
 * several kilobytes and twenty-five of them per page load is a real cost for a panel that is
 * opened rarely.
 */
export function ZatcaCell({
  documentId,
  status,
  isSigned,
  canSubmit,
}: {
  documentId: string;
  status: ZatcaStatus | null;
  isSigned: boolean;
  canSubmit: boolean;
}): JSX.Element {
  const [invoice, setInvoice] = useState<ZatcaPanelInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // A draft has no e-invoice: the envelope is produced at posting, because chaining a hash to
  // a document that may still be edited would fork the chain the moment it was.
  if (status === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  async function open(): Promise<void> {
    setLoading(true);
    setError(null);

    const result = await apiGet<ZatcaPanelInvoice>(
      `/api/system/zatca/invoice?documentId=${encodeURIComponent(documentId)}`,
    );

    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setInvoice(result.data);
  }

  return (
    <div className="flex items-center gap-1.5">
      <ZatcaStatusBadge status={status} isSigned={isSigned} />
      <button
        type="button"
        onClick={open}
        disabled={loading}
        aria-label="معاينة الفاتورة الإلكترونية"
        title="معاينة رمز QR وملف UBL"
        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>

      {error !== null ? (
        <span className="text-[11px] text-destructive" role="alert">
          {error.messageAr}
        </span>
      ) : null}

      {invoice !== null ? (
        <ZatcaPanel invoice={invoice} canSubmit={canSubmit} onClose={() => setInvoice(null)} />
      ) : null}
    </div>
  );
}
