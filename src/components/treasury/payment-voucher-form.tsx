'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EntityPicker } from '@/components/ui/entity-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Money } from '@/lib/domain/shared/money';
import { apiFetch, apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatDate, formatMoney } from '@/lib/utils/format';

/**
 * Receipt and payment voucher entry.
 *
 * The screen is built around one number — `unallocated` — for the same reason the journal
 * form is built around its balance and the reconciliation screen around its difference: it is
 * the single figure that says whether what has been entered makes sense, and it is arithmetic
 * a user should never have to do in their head.
 *
 * **The arithmetic is `Money`, not `number`.** Allocation amounts are summed through the same
 * scale-4 `bigint` type the API posts with, so the "remaining" figure on screen is the figure
 * the server will compute. Summing floats here would drift by a halala on a dozen lines and
 * the form would disagree with its own submission.
 *
 * **Over-allocation is refused before submitting, and again by the database.** The check here
 * exists to say *which* line is wrong while the user is still looking at it;
 * `erp_allocation_within_outstanding` exists because a check in a browser is a courtesy, not
 * a control.
 *
 * **Allocating nothing is allowed.** A customer advance settles no invoice yet. The voucher
 * carries the amount as unallocated, which the register then shows in its own column — the
 * honest representation of "money received against nothing in particular".
 */

interface FormOptions {
  readonly branches: readonly { id: string; code: string; nameAr: string }[];
  readonly currencies: readonly { code: string; nameAr: string }[];
  readonly accounts: readonly { id: string; code: string; nameAr: string; type: string }[];
  readonly functionalCurrency: string;
}

interface OutstandingDocument {
  readonly id: string;
  readonly documentNumber: string;
  readonly type: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly total: string;
  readonly paidAmount: string;
  readonly outstanding: string;
}

interface VoucherResult {
  readonly paymentId: string;
  readonly voucherNumber: string;
  readonly journalNumber: string;
  readonly allocatedAmount: string;
  readonly unallocatedAmount: string;
  readonly settledDocuments: readonly {
    documentId: string;
    documentNumber: string;
    status: string;
    outstanding: string;
  }[];
}

const METHODS = [
  { value: 'CASH', label: 'نقداً' },
  { value: 'BANK', label: 'تحويل بنكي' },
  { value: 'CHECK', label: 'شيك' },
  { value: 'CARD', label: 'بطاقة' },
];

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  SALES_INVOICE: 'فاتورة مبيعات',
  PURCHASE_INVOICE: 'فاتورة مشتريات',
  DEBIT_NOTE: 'إشعار مدين',
  CREDIT_NOTE: 'إشعار دائن',
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parses a user-typed amount without throwing on a half-typed one. */
function parseAmount(raw: string, currency: string): Money | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+(\.\d{0,4})?$/.test(trimmed)) return null;
  try {
    return Money.of(trimmed, currency);
  } catch {
    return null;
  }
}

export function PaymentVoucherForm(): JSX.Element {
  const [options, setOptions] = useState<FormOptions | null>(null);

  const [type, setType] = useState<'RECEIPT' | 'PAYMENT'>('RECEIPT');
  const [counterpartyId, setCounterpartyId] = useState('');
  const [counterpartyLabel, setCounterpartyLabel] = useState('');
  const [branchId, setBranchId] = useState('');
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [method, setMethod] = useState('BANK');
  const [accountId, setAccountId] = useState('');
  const [checkNumber, setCheckNumber] = useState('');
  const [checkDate, setCheckDate] = useState('');
  const [bankReference, setBankReference] = useState('');
  const [notes, setNotes] = useState('');

  const [documents, setDocuments] = useState<readonly OutstandingDocument[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<VoucherResult | null>(null);

  useEffect(() => {
    void apiFetch<FormOptions>('/api/master-data/form-options').then((response) => {
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setOptions(response.data);
      setCurrency(response.data.functionalCurrency);
      setBranchId(response.data.branches[0]?.id ?? '');
    });
  }, []);

  const loadDocuments = useCallback(
    async (nextCounterparty: string, nextType: 'RECEIPT' | 'PAYMENT'): Promise<void> => {
      if (nextCounterparty === '') {
        setDocuments([]);
        setAllocations({});
        return;
      }

      setLoadingDocuments(true);
      const response = await apiFetch<{ items: OutstandingDocument[] }>(
        `/api/treasury/payments/outstanding?counterpartyId=${nextCounterparty}&type=${nextType}`,
      );
      setLoadingDocuments(false);

      if (!response.ok) {
        setError(response.error);
        setDocuments([]);
        return;
      }

      setError(null);
      setDocuments(response.data.items);
      // Allocations are cleared rather than remapped: they belonged to the previous
      // counterparty's documents, and carrying a stale amount onto a new list is how a
      // voucher settles the wrong invoice.
      setAllocations({});
    },
    [],
  );

  useEffect(() => {
    void loadDocuments(counterpartyId, type);
  }, [counterpartyId, type, loadDocuments]);

  const voucherAmount = useMemo(() => parseAmount(amount, currency || 'SAR'), [amount, currency]);

  const allocatedTotal = useMemo(() => {
    const parts = Object.values(allocations)
      .map((raw) => parseAmount(raw, currency || 'SAR'))
      .filter((value): value is Money => value !== null);
    return Money.sum(parts, currency || 'SAR');
  }, [allocations, currency]);

  const unallocated = useMemo(() => {
    if (voucherAmount === null) return null;
    return voucherAmount.subtract(allocatedTotal);
  }, [voucherAmount, allocatedTotal]);

  /** Lines allocated more than the document still owes, named so the row can be marked. */
  const overAllocated = useMemo(() => {
    const bad = new Set<string>();
    for (const document of documents) {
      const entered = parseAmount(allocations[document.id] ?? '', document.currency);
      if (entered === null) continue;
      if (entered.greaterThan(Money.of(document.outstanding, document.currency))) {
        bad.add(document.id);
      }
    }
    return bad;
  }, [documents, allocations]);

  const overAllocatedTotal = unallocated !== null && unallocated.isNegative;

  const canSubmit =
    counterpartyId !== '' &&
    branchId !== '' &&
    accountId !== '' &&
    voucherAmount !== null &&
    voucherAmount.isPositive &&
    overAllocated.size === 0 &&
    !overAllocatedTotal &&
    !submitting;

  /** Fills the allocation grid oldest-due first until the voucher is exhausted. */
  function autoAllocate(): void {
    if (voucherAmount === null) return;

    let remaining = voucherAmount;
    const next: Record<string, string> = {};

    // `documents` arrives ordered by due date, so consuming it in order settles the oldest
    // debt first — which is what a customer expects and what an ageing report assumes.
    for (const document of documents) {
      if (!remaining.isPositive) break;
      const outstanding = Money.of(document.outstanding, document.currency);
      const applied = outstanding.greaterThan(remaining) ? remaining : outstanding;
      if (!applied.isPositive) continue;
      next[document.id] = applied.toFixed(2);
      remaining = remaining.subtract(applied);
    }

    setAllocations(next);
  }

  async function submit(): Promise<void> {
    if (!canSubmit || voucherAmount === null) return;

    setSubmitting(true);
    setError(null);
    setResult(null);

    const payload = {
      type,
      counterpartyId,
      branchId,
      paymentDate,
      amount: voucherAmount.toFixed(4),
      currency,
      method,
      accountId,
      ...(checkNumber.trim() !== '' ? { checkNumber: checkNumber.trim() } : {}),
      ...(checkDate !== '' ? { checkDate } : {}),
      ...(bankReference.trim() !== '' ? { bankReference: bankReference.trim() } : {}),
      ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
      allocations: Object.entries(allocations)
        .map(([documentId, raw]) => ({ documentId, value: parseAmount(raw, currency) }))
        .filter((entry) => entry.value !== null && entry.value.isPositive)
        .map((entry) => ({ documentId: entry.documentId, amount: entry.value!.toFixed(4) })),
    };

    const response = await apiPost<VoucherResult>('/api/treasury/payments', payload);
    setSubmitting(false);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setResult(response.data);
    // Reset the entry, keep the context. The next voucher is usually for the same branch,
    // account and currency, and re-picking them every time is the cost of a naive reset.
    setAmount('');
    setAllocations({});
    setCheckNumber('');
    setBankReference('');
    setNotes('');
    await loadDocuments(counterpartyId, type);
  }

  const cashAccounts = (options?.accounts ?? []).filter((account) => account.type === 'ASSET');

  return (
    <div className="space-y-6">
      {/* The banner: whether what has been entered adds up, answered before submitting. */}
      <div
        role="status"
        aria-live="polite"
        className={
          overAllocatedTotal || overAllocated.size > 0
            ? 'rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3'
            : 'rounded-lg border border-border bg-muted/40 px-4 py-3'
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2">
            {overAllocatedTotal || overAllocated.size > 0 ? (
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
            ) : null}
            <span className="font-medium">
              {overAllocatedTotal
                ? 'المخصَّص أكبر من مبلغ السند'
                : overAllocated.size > 0
                  ? 'سطر أو أكثر يتجاوز المتبقي على المستند'
                  : 'المبلغ غير المخصَّص'}
            </span>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">مبلغ السند</dt>
              <dd className="numeric font-medium">
                {formatMoney(voucherAmount?.toFixed(4) ?? '0', { currency: currency || 'SAR' })}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">المخصَّص</dt>
              <dd className="numeric font-medium">
                {formatMoney(allocatedTotal.toFixed(4), { currency: currency || 'SAR' })}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">غير مخصَّص</dt>
              <dd className="numeric font-medium">
                {formatMoney(unallocated?.toFixed(4) ?? '0', { currency: currency || 'SAR' })}
              </dd>
            </div>
          </dl>
        </div>
      </div>

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
          className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-success">
                رُحِّل السند <span className="bidi-isolate font-mono">{result.voucherNumber}</span>{' '}
                بالقيد <span className="bidi-isolate font-mono">{result.journalNumber}</span>.
              </p>
              {result.settledDocuments.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {result.settledDocuments.map((document) => (
                    <li key={document.documentId}>
                      <span className="bidi-isolate font-mono">{document.documentNumber}</span> —
                      المتبقي{' '}
                      <span className="numeric">
                        {formatMoney(document.outstanding, { currency: currency || 'SAR' })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader title="بيانات السند" description="القبض يسدد ما على العميل، والصرف يسدد ما للمورد" />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="نوع السند" required>
            <Select
              value={type}
              onChange={(event) => setType(event.target.value as 'RECEIPT' | 'PAYMENT')}
              options={[
                { value: 'RECEIPT', label: 'سند قبض' },
                { value: 'PAYMENT', label: 'سند صرف' },
              ]}
            />
          </Field>

          <Field
            label={type === 'RECEIPT' ? 'العميل' : 'المورد'}
            required
            className="sm:col-span-2"
          >
            <EntityPicker
              entity="counterparty"
              value={counterpartyId}
              valueLabel={counterpartyLabel}
              onSelect={(selection) => {
                setCounterpartyId(selection.id);
                setCounterpartyLabel(selection.label);
              }}
            />
          </Field>

          <Field label="التاريخ" required>
            <Input
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
            />
          </Field>

          <Field label="الفرع" required>
            <Select
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              placeholder="اختر الفرع"
              options={(options?.branches ?? []).map((branch) => ({
                value: branch.id,
                label: `${branch.code} · ${branch.nameAr}`,
              }))}
            />
          </Field>

          <Field label="العملة" required>
            <Select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              options={(options?.currencies ?? []).map((item) => ({
                value: item.code,
                label: `${item.code} · ${item.nameAr}`,
              }))}
            />
          </Field>

          <Field label="المبلغ" required>
            <Input
              numeric
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              invalid={amount !== '' && voucherAmount === null}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>

          <Field label="طريقة الدفع" required>
            <Select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              options={METHODS}
            />
          </Field>

          <Field label="الحساب النقدي / البنكي" required>
            <Select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="اختر الحساب"
              options={cashAccounts.map((account) => ({
                value: account.id,
                label: `${account.code} · ${account.nameAr}`,
              }))}
            />
          </Field>

          {method === 'CHECK' ? (
            <>
              <Field label="رقم الشيك">
                <Input
                  value={checkNumber}
                  onChange={(event) => setCheckNumber(event.target.value)}
                />
              </Field>
              <Field label="تاريخ الشيك">
                <Input
                  type="date"
                  value={checkDate}
                  onChange={(event) => setCheckDate(event.target.value)}
                />
              </Field>
            </>
          ) : null}

          {method === 'BANK' || method === 'CARD' ? (
            <Field label="المرجع البنكي">
              <Input
                value={bankReference}
                onChange={(event) => setBankReference(event.target.value)}
              />
            </Field>
          ) : null}

          <Field label="ملاحظات" className="sm:col-span-2 lg:col-span-3">
            <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="التخصيص على المستندات"
          description="الأقدم استحقاقاً أولاً. يمكن ترك السند دون تخصيص — يُسجَّل كدفعة مقدمة"
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={documents.length === 0 || voucherAmount === null}
              onClick={autoAllocate}
            >
              <Wand2 className="me-1.5 h-4 w-4" aria-hidden="true" />
              تخصيص تلقائي
            </Button>
          }
        />
        <CardBody>
          {counterpartyId === '' ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              اختر {type === 'RECEIPT' ? 'العميل' : 'المورد'} لعرض المستندات غير المسددة.
            </p>
          ) : loadingDocuments ? (
            <p className="py-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : documents.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              لا توجد مستندات غير مسددة لهذا الطرف.
            </p>
          ) : (
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
                      المتبقي
                    </th>
                    <th scope="col" className="numeric">
                      المخصَّص
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((document) => {
                    const bad = overAllocated.has(document.id);
                    return (
                      <tr key={document.id}>
                        <td>
                          <span className="bidi-isolate font-mono text-xs text-primary">
                            {document.documentNumber}
                          </span>
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {DOCUMENT_TYPE_LABELS[document.type] ?? document.type}
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {formatDate(document.dueDate)}
                        </td>
                        <td className="numeric text-muted-foreground">
                          {formatMoney(document.total, {
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
                        <td className="w-40">
                          <Input
                            numeric
                            inputMode="decimal"
                            placeholder="0.00"
                            invalid={bad}
                            aria-label={`المخصَّص للمستند ${document.documentNumber}`}
                            value={allocations[document.id] ?? ''}
                            onChange={(event) =>
                              setAllocations((previous) => ({
                                ...previous,
                                [document.id]: event.target.value,
                              }))
                            }
                          />
                          {bad ? (
                            <Badge tone="danger" className="mt-1">
                              يتجاوز المتبقي
                            </Badge>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="me-auto text-xs text-muted-foreground">
          السند يُرحَّل مباشرة إلى الأستاذ بقيد متوازن — لا يُحفظ كمسودة.
        </p>
        <Button loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          ترحيل السند
        </Button>
      </div>
    </div>
  );
}
