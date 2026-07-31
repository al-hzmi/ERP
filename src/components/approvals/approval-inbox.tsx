'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Inbox, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch, apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatDate, formatMoney } from '@/lib/utils/format';

/**
 * The approval inbox.
 *
 * Only requests waiting on *this* user appear, and that filtering happens in the
 * query rather than here: a request the caller cannot action never reaches the
 * browser. The consequence worth knowing is that an empty inbox is genuinely empty —
 * it does not mean "nothing pending in the company", it means nothing pending on you.
 *
 * Each decision is optimistic in exactly one direction: the row leaves the list on
 * success and comes back on failure. Rows are removed rather than greyed out because
 * a decision cannot be retaken — the service refuses a second action on the same
 * step — so leaving it visible would offer an action that is guaranteed to fail.
 */

interface PendingApproval {
  readonly requestId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly requestedAt: string;
  readonly requestedByName: string;
  readonly reference: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly descriptionAr: string | null;
  readonly ruleNameAr: string | null;
  readonly triggeredBy: readonly {
    readonly field: string;
    readonly operator: string;
    readonly threshold: string;
    readonly actual: string;
  }[];
}

const ENTITY_LABELS: Record<string, string> = {
  DOCUMENT: 'مستند',
  JOURNAL: 'قيد محاسبي',
  PAYMENT: 'سند دفع',
  TRADE_DOCUMENT: 'مستند تجاري',
};

const FIELD_LABELS: Record<string, string> = {
  TOTAL_AMOUNT: 'إجمالي المستند',
  SUBTOTAL: 'الصافي قبل الضريبة',
  TAX_AMOUNT: 'قيمة الضريبة',
  LINE_COUNT: 'عدد السطور',
  MAX_LINE_DISCOUNT_PERCENT: 'أعلى نسبة خصم في سطر',
};

const OPERATOR_LABELS: Record<string, string> = {
  GT: 'أكبر من',
  GTE: 'أكبر من أو يساوي',
  LT: 'أصغر من',
  LTE: 'أصغر من أو يساوي',
  EQ: 'يساوي',
  NEQ: 'لا يساوي',
};

export function ApprovalInbox(): JSX.Element {
  const [items, setItems] = useState<readonly PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  /** Which request is mid-decision, so only its own buttons show a spinner. */
  const [acting, setActing] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ requestId: string; message: string } | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await apiFetch<{ items: PendingApproval[]; total: number }>('/api/approvals');
    setLoading(false);

    if (!result.ok) {
      setLoadError(result.error);
      return;
    }

    setLoadError(null);
    setItems(result.data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(request: PendingApproval, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    setActing(request.requestId);
    setRowError(null);
    setOutcome(null);

    const comment = comments[request.requestId]?.trim() ?? '';

    const result = await apiPost<{ status: string; completed: boolean; currentStep: number }>(
      `/api/approvals/${request.requestId}/decision`,
      { decision, ...(comment !== '' ? { comment } : {}) },
    );

    setActing(null);

    if (!result.ok) {
      // A refusal here is usually meaningful — another approver got there first, or
      // the caller turns out to be the initiator — so it is shown against the row it
      // belongs to rather than as a page-level banner.
      setRowError({ requestId: request.requestId, message: result.error.messageAr });
      return;
    }

    setItems((current) => current.filter((entry) => entry.requestId !== request.requestId));
    setComments((current) => {
      const next = { ...current };
      delete next[request.requestId];
      return next;
    });

    const reference = request.reference ?? request.entityId;
    setOutcome(
      decision === 'REJECTED'
        ? `تم رفض ${reference}.`
        : result.data.completed
          ? `تم اعتماد ${reference} نهائياً.`
          : `تم اعتماد خطوتك على ${reference} — بانتظار الخطوة ${result.data.currentStep}.`,
    );
  }

  if (loadError !== null) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-destructive">{loadError.messageAr}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          إعادة المحاولة
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {loading ? 'جارٍ التحميل…' : `${items.length} طلب بانتظار قرارك`}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          تحديث
        </Button>
      </div>

      {outcome !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          {outcome}
        </div>
      ) : null}

      {!loading && items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">لا توجد طلبات بانتظار قرارك</p>
          <p className="max-w-md text-xs text-muted-foreground">
            تظهر هنا الطلبات التي تنتظر دورك تحديداً — بحسب الدور المسنَد إلى الخطوة
            الحالية. لا يعني خلو الصندوق عدم وجود طلبات في المنشأة.
          </p>
        </Card>
      ) : null}

      {items.map((request) => (
        <Card key={request.requestId}>
          <CardHeader
            title={request.reference ?? request.entityId}
            description={`${ENTITY_LABELS[request.entityType] ?? request.entityType} · طلبه ${request.requestedByName} في ${formatDate(request.requestedAt)}`}
            action={
              <Badge tone="warning">
                الخطوة {request.currentStep} من {request.totalSteps}
              </Badge>
            }
          />

          <CardBody className="space-y-4">
            {request.amount !== null ? (
              <p className="text-sm">
                <span className="text-muted-foreground">القيمة: </span>
                <span className="numeric font-medium">
                  {formatMoney(request.amount, { currency: request.currency ?? 'SAR' })}
                </span>
              </p>
            ) : null}

            {request.descriptionAr !== null && request.descriptionAr !== '' ? (
              <p className="text-sm text-muted-foreground">{request.descriptionAr}</p>
            ) : null}

            {/* Why this is here at all.

                An inbox that says only "approve this" asks the reviewer to trust that
                something, somewhere, decided it needed approving. Naming the rule and showing
                the numbers it matched — 62,000 against a 50,000 threshold — is what makes the
                request arguable instead of a rubber stamp.

                The facts are the ones frozen when the rule fired, not recomputed now: the rule
                may have been edited and the document revised since, and re-deriving them would
                show a reason that was never the reason. */}
            {request.ruleNameAr !== null ? (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  سبب الإيقاف
                </p>
                <p className="mt-0.5 text-xs font-medium">{request.ruleNameAr}</p>
                {request.triggeredBy.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {request.triggeredBy.map((clause) => (
                      <li key={clause.field} className="text-[11px] text-muted-foreground">
                        {FIELD_LABELS[clause.field] ?? clause.field}{' '}
                        {OPERATOR_LABELS[clause.operator] ?? clause.operator}{' '}
                        <span className="numeric">{clause.threshold}</span>
                        {' — '}
                        <span className="numeric font-medium text-foreground">
                          {clause.actual}
                        </span>{' '}
                        فعلياً
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    القاعدة تنطبق على كل مستندات هذا النوع.
                  </p>
                )}
              </div>
            ) : null}

            <Input
              placeholder="تعليق (اختياري — يُسجَّل مع قرارك)"
              value={comments[request.requestId] ?? ''}
              onChange={(event) =>
                setComments((current) => ({ ...current, [request.requestId]: event.target.value }))
              }
              aria-label={`تعليق على ${request.reference ?? request.entityId}`}
            />

            {rowError?.requestId === request.requestId ? (
              <p role="alert" className="text-sm text-destructive">
                {rowError.message}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-3">
              <Button
                variant="destructive"
                size="sm"
                loading={acting === request.requestId}
                onClick={() => void decide(request, 'REJECTED')}
              >
                <XCircle className="h-4 w-4" aria-hidden="true" />
                رفض
              </Button>
              <Button
                size="sm"
                loading={acting === request.requestId}
                onClick={() => void decide(request, 'APPROVED')}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                اعتماد
              </Button>
            </div>

            <p className="text-end text-xs text-muted-foreground">
              الرفض ينهي الطلب فوراً ولا ينتقل إلى الخطوة التالية.
            </p>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
