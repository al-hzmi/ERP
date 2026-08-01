'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EntityPicker } from '@/components/ui/entity-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DraftBanner } from '@/components/ui/draft-banner';
import { useDraftAutosave, useOnlineStatus } from '@/lib/offline/hooks';
import { submitOrQueue } from '@/lib/offline/sync';
import { apiFetch, type ApiError } from '@/lib/utils/api-client';
import { formatMoney } from '@/lib/utils/format';
import {
  isLineComplete,
  summariseDraft,
  toApiLines,
  type DraftLine,
} from '@/lib/utils/invoice-draft';

/**
 * Sales invoice entry.
 *
 * The totals shown here come from `calculateInvoice` — the same domain function the
 * API posts through — so the figure the user reads before saving is the figure that
 * gets saved. Recomputing tax and discounts in the component would be a second
 * implementation of the rules, and the two would agree until the day they did not.
 *
 * The invoice is created as a DRAFT. Posting is a separate, separately permissioned
 * action, because posting is what makes an invoice part of the ledger and part of the
 * ZATCA hash chain — it is not a save.
 */

interface TaxCodeOption {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  /** Percent as an exact string, e.g. `"15.00"`. */
  readonly rate: string;
  readonly treatment: string;
  readonly isDefault: boolean;
}

interface FormOptions {
  readonly branches: { id: string; code: string; nameAr: string }[];
  readonly warehouses: { id: string; code: string; nameAr: string; branchId: string }[];
  readonly currencies: { code: string; nameAr: string; minorUnits: number }[];
  readonly taxCodes: TaxCodeOption[];
  readonly functionalCurrency: string;
}

/**
 * The rate a line starts at before the tenant's tax codes have loaded.
 *
 * Replaced by the tenant's default the moment `/api/master-data/form-options` answers. It is a
 * constant rather than an empty string because a blank rate box on a form that has not finished
 * loading reads as a broken field, and this release is about exactly that impression.
 */
const FALLBACK_TAX_RATE = '15';

let nextLineId = 0;
function blankLine(): DraftLine {
  nextLineId += 1;
  return {
    id: `line-${nextLineId}`,
    productId: '',
    quantity: '1',
    unitPrice: '',
    discount: '',
    taxRate: FALLBACK_TAX_RATE,
    descriptionAr: '',
  };
}

/** `15.00` → `15`, `0.00` → `0`. The API's rate regex allows both; the shorter one reads. */
function trimRate(rate: string): string {
  return rate.replace(/\.00$/, '');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function InvoiceForm(): JSX.Element {
  const router = useRouter();

  const [options, setOptions] = useState<FormOptions | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [counterpartyId, setCounterpartyId] = useState('');
  const [counterpartyLabel, setCounterpartyLabel] = useState('');
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [productLabels, setProductLabels] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [queued, setQueued] = useState(false);

  const online = useOnlineStatus();

  /**
   * The shape persisted as a draft.
   *
   * Includes the picker labels, not just their ids: a restored draft that showed a bare
   * uuid where the customer's name should be would be worse than no draft at all, and
   * resolving the name needs a network the whole feature exists to do without.
   */
  const draftState = useMemo(
    () => ({
      counterpartyId,
      counterpartyLabel,
      branchId,
      warehouseId,
      issueDate,
      dueDate,
      currency,
      notes,
      lines,
      productLabels,
    }),
    [
      counterpartyId,
      counterpartyLabel,
      branchId,
      warehouseId,
      issueDate,
      dueDate,
      currency,
      notes,
      lines,
      productLabels,
    ],
  );

  const draft = useDraftAutosave('sales-invoice', draftState);

  function restoreDraft(): void {
    const state = draft.recovered?.state;
    if (state === undefined) return;

    setCounterpartyId(state.counterpartyId);
    setCounterpartyLabel(state.counterpartyLabel);
    setBranchId(state.branchId);
    setWarehouseId(state.warehouseId);
    setIssueDate(state.issueDate);
    setDueDate(state.dueDate);
    setCurrency(state.currency);
    setNotes(state.notes);
    setLines(state.lines);
    setProductLabels(state.productLabels);
    draft.dismissRecovered();
  }

  useEffect(() => {
    void apiFetch<FormOptions>('/api/master-data/form-options').then((result) => {
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setOptions(result.data);
      setCurrency(result.data.functionalCurrency);

      // Apply the tenant's default rate to lines the user has not touched. `blankLine()`
      // cannot do this itself — it runs before the fetch resolves — so the correction happens
      // here, and only for rows still holding the placeholder.
      const fallbackDefault = result.data.taxCodes.find((code) => code.isDefault);
      if (fallbackDefault !== undefined) {
        setLines((current) =>
          current.map((line) =>
            line.taxRate === FALLBACK_TAX_RATE
              ? { ...line, taxRate: trimRate(fallbackDefault.rate) }
              : line,
          ),
        );
      }
      // One branch is not a choice; preselecting it saves a click on every invoice.
      if (result.data.branches.length === 1) setBranchId(result.data.branches[0]?.id ?? '');
    });
  }, []);

  /**
   * The tax dropdown's entries.
   *
   * Keyed by *rate*, not by tax-code id, because the rate is what the API accepts and what the
   * calculator multiplies by. Two codes at the same rate would collide, so the label carries
   * the code's name and the value stays the number the posting path already understands —
   * changing the wire format would mean changing the calculator, the API schema and the ZATCA
   * builder together, which is a larger change than this defect warrants.
   */
  const taxRateOptions = useMemo(
    () =>
      (options?.taxCodes ?? []).map((taxCode) => ({
        value: trimRate(taxCode.rate),
        label: `${taxCode.nameAr} (${trimRate(taxCode.rate)}%)`,
      })),
    [options],
  );

  // Warehouses belong to branches. Offering all of them lets a user file a Riyadh
  // invoice against a Jeddah warehouse, which the stock movement would then honour.
  const warehousesForBranch = useMemo(
    () => (options ?? { warehouses: [] }).warehouses.filter((w) => w.branchId === branchId),
    [options, branchId],
  );

  useEffect(() => {
    if (warehouseId !== '' && !warehousesForBranch.some((w) => w.id === warehouseId)) {
      setWarehouseId('');
    }
  }, [warehousesForBranch, warehouseId]);

  const summary = useMemo(() => summariseDraft(lines, currency), [lines, currency]);
  const totals = summary.ok ? summary.totals : null;

  const headerReady = counterpartyId !== '' && branchId !== '' && issueDate !== '';
  const hasCompleteLine = lines.some(isLineComplete);
  const canSubmit = headerReady && hasCompleteLine && summary.ok && !submitting;

  function updateLine(id: string, patch: Partial<DraftLine>): void {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setAttempted(true);
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    // Goes through the offline queue rather than straight to `fetch`, so a submission
    // made with no connection is kept and replayed under an idempotency key instead of
    // being lost — or worse, sent twice.
    const result = await submitOrQueue<{ documentId: string; documentNumber: string }>(
      'sales-invoice',
      '/api/sales/invoices',
      {
        counterpartyId,
        branchId,
        ...(warehouseId !== '' ? { warehouseId } : {}),
        issueDate,
        ...(dueDate !== '' ? { dueDate } : {}),
        currency,
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
        lines: toApiLines(lines),
      },
    );

    if (result.outcome === 'refused') {
      setError({ code: result.code, messageAr: result.messageAr, messageEn: result.messageAr });
      setSubmitting(false);
      return;
    }

    // The draft has served its purpose either way: accepted means it is filed, queued
    // means the queue owns it now and restoring it later would create a second copy.
    draft.discard();

    if (result.outcome === 'queued') {
      // Stays on the page. Navigating to the register would show a list that does not
      // contain the invoice, which reads as the submission having failed.
      setQueued(true);
      setSubmitting(false);
      return;
    }

    // `refresh` before navigating, so the register the user lands on includes the
    // invoice they just raised rather than a cached list without it.
    router.refresh();
    router.push('/sales/invoices');
  }

  if (loadError !== null) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-destructive">{loadError.messageAr}</p>
      </Card>
    );
  }

  if (options === null) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted-foreground">جارٍ تحميل بيانات النموذج…</p>
      </Card>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="space-y-6" noValidate>
      {draft.recovered !== null ? (
        <DraftBanner
          savedAt={draft.recovered.updatedAt}
          onRestore={restoreDraft}
          onDiscard={() => {
            draft.discard();
            draft.dismissRecovered();
          }}
        />
      ) : null}

      {queued ? (
        <div
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
        >
          <span className="font-medium">تم حفظ الفاتورة في طابور الإرسال.</span>{' '}
          <span className="text-muted-foreground">
            لم تُسجَّل في النظام بعد ولم يُخصَّص لها رقم — سيتم إرسالها تلقائياً عند عودة
            الاتصال.
          </span>
        </div>
      ) : null}

      <Card>
        <CardHeader title="بيانات الفاتورة" description="العميل والفرع والتواريخ" />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="العميل"
            required
            error={attempted && counterpartyId === '' ? 'يجب اختيار العميل.' : undefined}
          >
            <EntityPicker
              entity="counterparty"
              // A sales invoice's customer, not any trading partner: without this the list
              // offers suppliers, and choosing one raises a receivable against a company we
              // owe money to.
              counterpartyType="CUSTOMER"
              value={counterpartyId}
              valueLabel={counterpartyLabel}
              placeholder="اختر العميل أو ابحث بالاسم/الرمز…"
              onSelect={(selection) => {
                setCounterpartyId(selection.id);
                setCounterpartyLabel(
                  selection.id === '' ? '' : `${selection.label} — ${selection.code}`,
                );
              }}
            />
          </Field>

          <Field
            label="الفرع"
            required
            error={attempted && branchId === '' ? 'يجب اختيار الفرع.' : undefined}
          >
            <Select
              placeholder="اختر الفرع"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              options={options.branches.map((branch) => ({
                value: branch.id,
                label: `${branch.code} — ${branch.nameAr}`,
              }))}
            />
          </Field>

          <Field
            label="المستودع"
            hint={
              branchId === ''
                ? 'اختر الفرع أولاً'
                : 'اختياري — يُستخدم عند ترحيل الفاتورة لإخراج المخزون'
            }
          >
            <Select
              placeholder="بدون مستودع"
              disabled={branchId === ''}
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
              options={warehousesForBranch.map((warehouse) => ({
                value: warehouse.id,
                label: `${warehouse.code} — ${warehouse.nameAr}`,
              }))}
            />
          </Field>

          <Field label="تاريخ الإصدار" required>
            <Input
              type="date"
              value={issueDate}
              onChange={(event) => setIssueDate(event.target.value)}
            />
          </Field>

          <Field label="تاريخ الاستحقاق" hint="يُحتسب من شروط سداد العميل إن تُرك فارغاً">
            <Input
              type="date"
              value={dueDate}
              min={issueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </Field>

          <Field label="العملة" required>
            <Select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              options={options.currencies.map((entry) => ({
                value: entry.code,
                label: `${entry.code} — ${entry.nameAr}`,
              }))}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="البنود"
          description="الإجماليات تُحسب بنفس الدالة التي يستخدمها الترحيل"
        />

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="w-8">
                  #
                </th>
                <th scope="col" className="min-w-[16rem]">
                  الصنف
                </th>
                <th scope="col" className="numeric w-28">
                  الكمية
                </th>
                <th scope="col" className="numeric w-32">
                  سعر الوحدة
                </th>
                <th scope="col" className="numeric w-28">
                  الخصم
                </th>
                <th scope="col" className="numeric w-24">
                  الضريبة %
                </th>
                <th scope="col" className="w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.id}>
                  <td className="numeric text-xs text-muted-foreground">{index + 1}</td>
                  <td>
                    <EntityPicker
                      entity="product"
                      value={line.productId}
                      valueLabel={productLabels[line.productId]}
                      placeholder="اختر الصنف أو ابحث بالرمز/الاسم…"
                      onSelect={(selection) => {
                        updateLine(line.id, { productId: selection.id });
                        if (selection.id !== '') {
                          setProductLabels((current) => ({
                            ...current,
                            [selection.id]: `${selection.label} — ${selection.code}`,
                          }));
                        }
                      }}
                    />
                  </td>
                  <td>
                    <Input
                      numeric
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.id, { quantity: event.target.value })}
                      aria-label={`الكمية للبند ${index + 1}`}
                    />
                  </td>
                  <td>
                    <Input
                      numeric
                      inputMode="decimal"
                      value={line.unitPrice}
                      onChange={(event) => updateLine(line.id, { unitPrice: event.target.value })}
                      aria-label={`سعر الوحدة للبند ${index + 1}`}
                    />
                  </td>
                  <td>
                    <Input
                      numeric
                      inputMode="decimal"
                      placeholder="0"
                      value={line.discount}
                      onChange={(event) => updateLine(line.id, { discount: event.target.value })}
                      aria-label={`الخصم للبند ${index + 1}`}
                    />
                  </td>
                  <td>
                    {/* A dropdown of the tenant's VAT treatments rather than a free-text
                        percentage. Typing `0` used to be the only way to express an export,
                        which conflates zero-rated with exempt — different lines of the VAT
                        return and different ZATCA category letters. Until the codes load it
                        stays a text box, so the field is never disabled or blank. */}
                    {options === null || options.taxCodes.length === 0 ? (
                      <Input
                        numeric
                        inputMode="decimal"
                        value={line.taxRate}
                        onChange={(event) => updateLine(line.id, { taxRate: event.target.value })}
                        aria-label={`نسبة الضريبة للبند ${index + 1}`}
                      />
                    ) : (
                      <Select
                        value={line.taxRate}
                        onChange={(event) => updateLine(line.id, { taxRate: event.target.value })}
                        aria-label={`المعالجة الضريبية للبند ${index + 1}`}
                        options={taxRateOptions}
                      />
                    )}
                  </td>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      // The last line is never removable: a form with no rows gives
                      // the user nothing to type into and no obvious way back.
                      disabled={lines.length === 1}
                      onClick={() =>
                        setLines((current) => current.filter((entry) => entry.id !== line.id))
                      }
                      aria-label={`حذف البند ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <CardBody className="flex flex-wrap items-center justify-between gap-4 border-t border-border">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((current) => [...current, blankLine()])}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            إضافة بند
          </Button>

          {totals !== null && totals.incompleteLines > 0 ? (
            <p className="text-xs text-muted-foreground">
              {totals.incompleteLines} بند غير مكتمل — لن يُحتسب في الإجمالي ولن يُرسل
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <Field label="ملاحظات">
            <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>

          {summary.ok ? (
            <dl className="ms-auto w-full max-w-sm space-y-2 text-sm">
              <Row
                label="الإجمالي قبل الضريبة"
                value={formatMoney(summary.totals.subtotal, { currency })}
              />
              <Row label="الخصم" value={formatMoney(summary.totals.discountTotal, { currency })} />
              <Row
                label="ضريبة القيمة المضافة"
                value={formatMoney(summary.totals.taxTotal, { currency })}
              />
              <div className="flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
                <dt>الإجمالي</dt>
                <dd className="numeric">{formatMoney(summary.totals.total, { currency })}</dd>
              </div>
            </dl>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {summary.message}
            </p>
          )}

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error.messageAr}
            </p>
          ) : null}

          {attempted && !hasCompleteLine ? (
            <p role="alert" className="text-sm text-destructive">
              يجب إضافة بند مكتمل واحد على الأقل.
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => router.push('/sales/invoices')}>
              إلغاء
            </Button>
            <Button type="submit" loading={submitting} disabled={!canSubmit}>
              حفظ كمسودة
            </Button>
          </div>

          <p className="text-end text-xs text-muted-foreground">
            تُحفظ الفاتورة كمسودة. الترحيل خطوة منفصلة تتطلب صلاحية الترحيل.
            {draft.savedAt !== null ? (
              <>
                {' · '}
                {draft.durable
                  ? 'المسودة محفوظة على هذا الجهاز'
                  : 'المسودة محفوظة في هذه النافذة فقط'}
              </>
            ) : null}
            {!online ? <> · لا يوجد اتصال — سيُرسل عند العودة</> : null}
          </p>
        </CardBody>
      </Card>
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="numeric">{value}</dd>
    </div>
  );
}
