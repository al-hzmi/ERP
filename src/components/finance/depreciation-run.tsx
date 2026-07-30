'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, ListTree, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiFetch, apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatDate, formatMoney } from '@/lib/utils/format';

/**
 * The depreciation run.
 *
 * Two things this screen is built around, both of which are refusals rather than features.
 *
 * **Nothing posts without a preview.** The button says how many charges and for how much
 * before it does anything, because a depreciation run is one of the few operations here that
 * touches every asset at once — and undoing it means a reversing journal, not a delete.
 *
 * **Skipped assets are shown, not swallowed.** An asset with an unposted earlier month is
 * left out of the run, and a screen that silently posted the rest would leave the user
 * believing the register is current when one asset is a month behind. The skip list is
 * therefore as prominent as the charge list, and each row says why.
 *
 * The register table below is the other half: it exists so someone can see, per asset,
 * whether a schedule has been generated at all. An asset with no schedule is invisible to the
 * runner — it is not *late*, it is *absent* — and that distinction is impossible to draw from
 * a run result alone.
 */

interface AssetListItem {
  readonly id: string;
  readonly assetNumber: string;
  readonly nameAr: string;
  readonly method: 'STRAIGHT_LINE' | 'DECLINING_BALANCE';
  readonly acquisitionDate: string;
  readonly acquisitionCost: string;
  readonly salvageValue: string;
  readonly usefulLifeMonths: number;
  readonly accumulatedDepreciation: string;
  readonly netBookValue: string;
  readonly disposedAt: string | null;
  readonly scheduledPeriods: number;
  readonly postedPeriods: number;
  readonly nextDueDate: string | null;
}

interface DueCharge {
  readonly scheduleId: string;
  readonly assetId: string;
  readonly assetNumber: string;
  readonly assetNameAr: string;
  readonly periodDate: string;
  readonly amount: string;
  readonly expenseAccountCode: string;
  readonly accumulatedAccountCode: string;
}

interface SkippedAsset {
  readonly assetId: string;
  readonly assetNumber: string;
  readonly reasonAr: string;
  readonly reasonEn: string;
}

interface RunPreview {
  readonly asOf: string;
  readonly charges: readonly DueCharge[];
  readonly totalAmount: string;
  readonly skipped: readonly SkippedAsset[];
}

interface RunResult {
  readonly asOf: string;
  readonly journalId: string | null;
  readonly entryNumber: string | null;
  readonly postedCount: number;
  readonly totalAmount: string;
  readonly skipped: readonly SkippedAsset[];
}

const METHOD_LABELS: Record<AssetListItem['method'], string> = {
  STRAIGHT_LINE: 'القسط الثابت',
  DECLINING_BALANCE: 'القسط المتناقص',
};

/** Today in `YYYY-MM-DD`, in UTC, matching how the server reads a bare date. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DepreciationRun(): JSX.Element {
  const [asOf, setAsOf] = useState(today);
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [assets, setAssets] = useState<readonly AssetListItem[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const currency = 'SAR';

  const loadAssets = useCallback(async (): Promise<void> => {
    const response = await apiFetch<{ items: AssetListItem[] }>('/api/finance/assets');
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setAssets(response.data.items);
  }, []);

  const loadPreview = useCallback(async (date: string): Promise<void> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

    setLoading(true);
    const response = await apiFetch<RunPreview>(
      `/api/finance/depreciation?asOf=${encodeURIComponent(date)}`,
    );
    setLoading(false);

    if (!response.ok) {
      setError(response.error);
      setPreview(null);
      return;
    }

    setError(null);
    setPreview(response.data);
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    void loadPreview(asOf);
  }, [asOf, loadPreview]);

  async function generate(assetId: string): Promise<void> {
    setBusy(`generate:${assetId}`);
    setError(null);

    const response = await apiPost<{ created: number; existing: number; total: number }>(
      `/api/finance/assets/${assetId}/schedule`,
      {},
    );
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    await Promise.all([loadAssets(), loadPreview(asOf)]);
  }

  async function run(): Promise<void> {
    setBusy('run');
    setError(null);
    setResult(null);

    const response = await apiPost<RunResult>('/api/finance/depreciation', { asOf });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setResult(response.data);
    await Promise.all([loadAssets(), loadPreview(asOf)]);
  }

  const dueCount = preview?.charges.length ?? 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="فترة التشغيل"
          description="تُرحَّل كل الأقساط المستحقة حتى هذا التاريخ في قيد واحد"
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="حتى تاريخ" required>
            <Input
              type="date"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
              aria-describedby="asof-help"
            />
          </Field>
          <p id="asof-help" className="self-end text-xs text-muted-foreground">
            القسط يُستحق بانتهاء شهره، لا بأوّله. اترك التاريخ على اليوم للتشغيل الشهري
            المعتاد، أو أرجعه لإغلاق شهر فائت.
          </p>
        </CardBody>
      </Card>

      {error !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error.messageAr}
        </div>
      ) : null}

      {result !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-success/30 bg-success/10 px-4 py-3"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              {result.postedCount === 0 ? (
                <p className="font-medium text-success">
                  لا توجد أقساط مستحقة حتى {formatDate(result.asOf)} — لم يُرحَّل أي قيد.
                </p>
              ) : (
                <>
                  <p className="font-medium text-success">
                    رُحِّل {result.postedCount} قسطاً بإجمالي{' '}
                    {formatMoney(result.totalAmount, { currency })} في القيد{' '}
                    <span className="bidi-isolate font-mono">{result.entryNumber}</span>.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    مدين: مصروف الإهلاك · دائن: مجمَّع الإهلاك. تكلفة الأصل لم تتغيّر.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Skipped assets, from the live preview or the last run — whichever is more recent.
          Placed above the charge list on purpose: what the run will *not* do is the part a
          user cannot infer from anywhere else on the screen. */}
      {(result?.skipped ?? preview?.skipped ?? []).length > 0 ? (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">أصول مُستثناة من هذا التشغيل</p>
              <ul className="mt-2 space-y-1 text-xs">
                {(result?.skipped ?? preview?.skipped ?? []).map((skip) => (
                  <li key={skip.assetId} className="flex flex-wrap items-center gap-2">
                    <span className="bidi-isolate font-mono text-primary">
                      {skip.assetNumber}
                    </span>
                    <span className="text-muted-foreground">{skip.reasonAr}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                رحِّل الأقساط الأقدم أولاً — القفز فوق شهر يجعل مجمَّع الإهلاك في سجل الأصول
                أعلى من الواقع.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="الأقساط المستحقة"
          description={
            loading
              ? 'جارٍ الحساب…'
              : `${dueCount} قسطاً بإجمالي ${formatMoney(preview?.totalAmount ?? '0', { currency })}`
          }
          action={
            <Button
              size="sm"
              loading={busy === 'run'}
              disabled={dueCount === 0 || loading}
              onClick={() => void run()}
            >
              <Play className="me-1.5 h-4 w-4" aria-hidden="true" />
              ترحيل الإهلاك
            </Button>
          }
        />
        <CardBody>
          {dueCount === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <CalendarClock className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                لا توجد أقساط مستحقة حتى هذا التاريخ.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">الأصل</th>
                    <th scope="col">الشهر</th>
                    <th scope="col">حساب المصروف</th>
                    <th scope="col">حساب المجمَّع</th>
                    <th scope="col" className="text-end">
                      القسط
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview?.charges.map((charge) => (
                    <tr key={charge.scheduleId}>
                      <td className="max-w-xs">
                        <span className="bidi-isolate font-mono text-xs text-primary">
                          {charge.assetNumber}
                        </span>
                        <span className="ms-2 truncate text-xs text-muted-foreground">
                          {charge.assetNameAr}
                        </span>
                      </td>
                      <td className="whitespace-nowrap">{formatDate(charge.periodDate)}</td>
                      <td className="bidi-isolate font-mono text-xs">
                        {charge.expenseAccountCode}
                      </td>
                      <td className="bidi-isolate font-mono text-xs">
                        {charge.accumulatedAccountCode}
                      </td>
                      <td className="numeric">
                        {formatMoney(charge.amount, { currency, showCurrency: false })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <td colSpan={4}>الإجمالي</td>
                    <td className="numeric">
                      {formatMoney(preview?.totalAmount ?? '0', {
                        currency,
                        showCurrency: false,
                      })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="سجل الأصول الثابتة"
          description="الأصل بلا جدول إهلاك لا يظهر في التشغيل — وهذا ما يُظهره هذا الجدول"
        />
        <CardBody>
          {assets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <ListTree className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">لا توجد أصول ثابتة مُسجَّلة.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">الرقم</th>
                    <th scope="col">الأصل</th>
                    <th scope="col">الطريقة</th>
                    <th scope="col" className="text-end">
                      التكلفة
                    </th>
                    <th scope="col" className="text-end">
                      مجمَّع الإهلاك
                    </th>
                    <th scope="col" className="text-end">
                      القيمة الدفترية
                    </th>
                    <th scope="col">الجدول</th>
                    <th scope="col">القسط القادم</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr key={asset.id}>
                      <td className="bidi-isolate font-mono text-xs text-primary">
                        {asset.assetNumber}
                      </td>
                      <td className="max-w-xs truncate">{asset.nameAr}</td>
                      <td className="text-xs">{METHOD_LABELS[asset.method]}</td>
                      <td className="numeric">
                        {formatMoney(asset.acquisitionCost, { currency, showCurrency: false })}
                      </td>
                      <td className="numeric">
                        {formatMoney(asset.accumulatedDepreciation, {
                          currency,
                          showCurrency: false,
                        })}
                      </td>
                      <td className="numeric">
                        {formatMoney(asset.netBookValue, { currency, showCurrency: false })}
                      </td>
                      <td className="text-xs">
                        {asset.scheduledPeriods === 0 ? (
                          <Badge tone="warning">لا يوجد جدول</Badge>
                        ) : asset.postedPeriods === asset.scheduledPeriods ? (
                          <Badge tone="success">مكتمل</Badge>
                        ) : (
                          <span className="numeric">
                            {asset.postedPeriods} / {asset.scheduledPeriods}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {asset.nextDueDate === null ? '—' : formatDate(asset.nextDueDate)}
                      </td>
                      <td>
                        {asset.scheduledPeriods < asset.usefulLifeMonths ? (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={busy === `generate:${asset.id}`}
                            onClick={() => void generate(asset.id)}
                          >
                            توليد الجدول
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
