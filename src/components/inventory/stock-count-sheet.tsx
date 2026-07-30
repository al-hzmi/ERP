'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Save, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch, apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatMoney } from '@/lib/utils/format';

/**
 * The count sheet.
 *
 * Built around one distinction the whole feature rests on: **empty is not zero**. An input left
 * blank means nobody reached that line; a typed `0` means the shelf was empty, which is very
 * often the most important finding on the sheet. The two are stored differently, submitted
 * differently, and shown differently — a blank row is grey and excluded from the variance
 * totals, a zero row is a shortage like any other.
 *
 * **The variance is computed against the frozen expected quantity**, which arrived with the
 * sheet and is never re-fetched. Recomputing it against a live balance would produce a number
 * that changes while the user is typing, for reasons that have nothing to do with what is on
 * the shelf.
 *
 * **Entries are saved before finalising, not with it.** A count is entered over hours, often by
 * more than one person; holding it all in the browser until a single button press is how an
 * afternoon's work is lost to a closed tab.
 */

interface CountLine {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly expectedQuantity: string;
  readonly countedQuantity: string | null;
  readonly unitCostAtOpen: string;
  readonly variance: string | null;
  readonly varianceValue: string | null;
  readonly adjustmentMovementId: string | null;
}

interface CountView {
  readonly id: string;
  readonly countNumber: string;
  readonly status: 'COUNTING' | 'COMPLETED' | 'CANCELLED';
  readonly countDate: string;
  readonly notes: string | null;
  readonly warehouse: { code: string; nameAr: string };
  readonly lines: readonly CountLine[];
  readonly summary: {
    totalLines: number;
    countedLines: number;
    varianceLines: number;
    shortageValue: string;
    surplusValue: string;
    netValue: string;
  };
}

const STATUS_LABELS: Record<string, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
  COUNTING: { label: 'جارٍ العدّ', tone: 'info' },
  COMPLETED: { label: 'مُعتمد', tone: 'success' },
  CANCELLED: { label: 'ملغى', tone: 'neutral' },
};

export function StockCountSheet({ countId }: { countId: string }): JSX.Element {
  const [view, setView] = useState<CountView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const response = await apiFetch<CountView>(`/api/inventory/counts/${countId}`);
    setLoading(false);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setError(null);
    setView(response.data);
    // Seeded from the server so a reload shows what was saved, and so an unsaved edit is
    // visibly different from a saved one.
    setDrafts(
      Object.fromEntries(
        response.data.lines.map((line) => [line.id, line.countedQuantity ?? '']),
      ),
    );
  }, [countId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    if (view === null) return;

    setBusy('save');
    setError(null);
    setNotice(null);

    const entries = view.lines
      .filter((line) => (drafts[line.id] ?? '') !== (line.countedQuantity ?? ''))
      .map((line) => ({
        lineId: line.id,
        // An empty box unsets the line rather than counting zero.
        countedQuantity: (drafts[line.id] ?? '').trim() === '' ? null : (drafts[line.id] ?? '').trim(),
      }));

    if (entries.length === 0) {
      setBusy(null);
      setNotice('لا توجد تغييرات لحفظها.');
      return;
    }

    const response = await apiPost<{ updated: number }>(`/api/inventory/counts/${countId}`, {
      action: 'record',
      entries,
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setNotice(`حُفظ ${response.data.updated} سطراً.`);
    await load();
  }

  async function close(action: 'finalise' | 'cancel'): Promise<void> {
    setBusy(action);
    setError(null);
    setNotice(null);

    const response = await apiPost<{
      adjustmentsPosted?: number;
      uncountedLines?: number;
      netValue?: string;
    }>(`/api/inventory/counts/${countId}`, { action });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setNotice(
      action === 'cancel'
        ? 'أُلغي الجرد دون ترحيل أي تسوية.'
        : `رُحِّلت ${response.data.adjustmentsPosted ?? 0} تسوية. ${
            (response.data.uncountedLines ?? 0) > 0
              ? `${response.data.uncountedLines} سطراً لم يُعدّ ولم يُمَس.`
              : 'كل السطور عُدّت.'
          }`,
    );
    await load();
  }

  if (loading && view === null) {
    return (
      <Card>
        <div className="p-10 text-center text-sm text-muted-foreground">جارٍ تحميل ورقة الجرد…</div>
      </Card>
    );
  }

  if (view === null) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        {error?.messageAr ?? 'تعذّر تحميل ورقة الجرد.'}
      </div>
    );
  }

  const editable = view.status === 'COUNTING';
  const status = STATUS_LABELS[view.status] ?? { label: view.status, tone: 'neutral' as const };
  const dirty = view.lines.some((line) => (drafts[line.id] ?? '') !== (line.countedQuantity ?? ''));
  const currency = 'SAR';

  return (
    <div className="space-y-6">
      {error !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error.messageAr}
        </div>
      ) : null}

      {notice !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm"
        >
          {notice}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="التقدّم"
          value={`${view.summary.countedLines} / ${view.summary.totalLines}`}
          hint="السطر الفارغ لم يُعدّ — وليس صفراً"
        />
        <Tile label="سطور بها فروقات" value={view.summary.varianceLines.toString()} />
        <Tile
          label="قيمة العجز"
          value={formatMoney(view.summary.shortageValue, { currency })}
          tone="danger"
        />
        <Tile
          label="قيمة الزيادة"
          value={formatMoney(view.summary.surplusValue, { currency })}
          tone="success"
        />
      </div>

      <Card>
        <CardHeader
          title={`${view.countNumber} · ${view.warehouse.nameAr}`}
          description={
            editable
              ? 'الكمية المتوقعة مُجمَّدة لحظة فتح الورقة ولا تتغيّر أثناء العدّ'
              : 'ورقة مُغلقة — للعرض فقط'
          }
          action={<Badge tone={status.tone}>{status.label}</Badge>}
        />

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الصنف</th>
                <th scope="col" className="numeric">المتوقع</th>
                <th scope="col" className="numeric">المعدود</th>
                <th scope="col" className="numeric">الفرق</th>
                <th scope="col" className="numeric">قيمة الفرق</th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((line) => {
                const draft = drafts[line.id] ?? '';
                const typed = draft.trim();
                const uncounted = typed === '';
                const parsed = uncounted ? null : Number(typed);
                const liveVariance =
                  parsed === null || !Number.isFinite(parsed)
                    ? null
                    : parsed - Number(line.expectedQuantity);
                const changed = draft !== (line.countedQuantity ?? '');

                return (
                  <tr key={line.id} className={uncounted ? 'opacity-60' : undefined}>
                    <td className="max-w-[18rem]">
                      <span className="bidi-isolate font-mono text-xs text-primary">{line.sku}</span>
                      <p className="truncate text-xs text-muted-foreground">{line.nameAr}</p>
                    </td>
                    <td className="numeric text-muted-foreground">{line.expectedQuantity}</td>
                    <td className="w-32">
                      {editable ? (
                        <Input
                          numeric
                          inputMode="decimal"
                          placeholder="—"
                          aria-label={`الكمية المعدودة للصنف ${line.sku}`}
                          value={draft}
                          onChange={(event) =>
                            setDrafts((previous) => ({ ...previous, [line.id]: event.target.value }))
                          }
                        />
                      ) : (
                        <span className="numeric">{line.countedQuantity ?? '—'}</span>
                      )}
                    </td>
                    <td className="numeric">
                      {liveVariance === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={
                            liveVariance < 0
                              ? 'font-medium text-destructive'
                              : liveVariance > 0
                                ? 'font-medium text-success'
                                : 'text-muted-foreground'
                          }
                        >
                          {liveVariance > 0 ? `+${liveVariance}` : liveVariance}
                        </span>
                      )}
                    </td>
                    <td className="numeric text-muted-foreground">
                      {line.varianceValue === null
                        ? '—'
                        : formatMoney(line.varianceValue, { currency, showCurrency: false })}
                    </td>
                    <td>
                      {line.adjustmentMovementId !== null ? (
                        <Badge tone="success">رُحِّلت</Badge>
                      ) : uncounted ? (
                        <Badge tone="neutral">لم يُعدّ</Badge>
                      ) : changed ? (
                        <Badge tone="warning">غير محفوظ</Badge>
                      ) : (
                        <Badge tone="info">محفوظ</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {editable ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="me-auto text-xs text-muted-foreground">
            الاعتماد يُرحِّل كل فرق كتسوية مخزون بقيد محاسبي — عملية واحدة، إما كلها أو لا شيء.
          </p>
          <Button variant="outline" loading={busy === 'save'} disabled={!dirty} onClick={() => void save()}>
            <Save className="me-1.5 h-4 w-4" aria-hidden="true" />
            حفظ الكميات
          </Button>
          <Button
            variant="outline"
            loading={busy === 'cancel'}
            onClick={() => void close('cancel')}
          >
            <XCircle className="me-1.5 h-4 w-4" aria-hidden="true" />
            إلغاء الجرد
          </Button>
          <Button
            loading={busy === 'finalise'}
            disabled={dirty || view.summary.countedLines === 0}
            onClick={() => void close('finalise')}
          >
            <CheckCircle2 className="me-1.5 h-4 w-4" aria-hidden="true" />
            اعتماد وترحيل الفروقات
          </Button>
        </div>
      ) : null}

      {editable && dirty ? (
        <p className="flex items-center justify-end gap-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          احفظ الكميات قبل الاعتماد — الاعتماد يُرحِّل المحفوظ لا المكتوب على الشاشة.
        </p>
      ) : null}

      {!editable && view.summary.varianceLines > 0 ? (
        <Card>
          <CardBody>
            <div className="flex items-center gap-3 text-sm">
              <ClipboardCheck className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-muted-foreground">
                صافي أثر هذا الجرد على قيمة المخزون:{' '}
                <span className="numeric font-medium">
                  {formatMoney(view.summary.netValue, { currency })}
                </span>
              </span>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'danger' | 'success';
}): JSX.Element {
  return (
    <Card>
      <CardBody>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={
            tone === 'danger'
              ? 'numeric mt-1 text-2xl font-semibold text-destructive'
              : tone === 'success'
                ? 'numeric mt-1 text-2xl font-semibold text-success'
                : 'numeric mt-1 text-2xl font-semibold'
          }
        >
          {value}
        </p>
        {hint !== undefined ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}
