'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Link2Off, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { apiFetch, apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatDate, formatMoney } from '@/lib/utils/format';

/**
 * Bank reconciliation.
 *
 * The banner is the screen, as it is on the journal entry form: the whole exercise
 * produces one number, and it either is zero or it is not. Presenting it as two columns
 * that have to meet — per bank, per books — is what tells the person *which side* the
 * unexplained amount is on, which is the difference between a five-minute check and an
 * afternoon.
 *
 * Two deliberate refusals surface here:
 *
 *   - **Sign-off is disabled while a difference remains.** A button that let someone
 *     assert agreement that does not exist would make the reconciled flag mean "somebody
 *     clicked".
 *   - **The automatic pass reports what it declined.** A matcher that silently skipped the
 *     ambiguous cases would leave the user believing it had considered them.
 */

interface StatementListItem {
  readonly id: string;
  readonly statementRef: string;
  readonly accountCode: string;
  readonly accountNameAr: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly closingBalance: string;
  readonly isReconciled: boolean;
  readonly unmatchedLines: number;
}

interface Candidate {
  readonly paymentId: string;
  readonly voucherNumber: string;
  readonly counterpartyName: string;
  readonly paymentDate: string;
  readonly amount: string;
  readonly score: number;
  readonly reasonsAr: readonly string[];
}

interface ReconciliationLine {
  readonly id: string;
  readonly valueDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly debit: string;
  readonly credit: string;
  readonly direction: 'IN' | 'OUT' | null;
  readonly matchedPaymentId: string | null;
  readonly matchedVoucherNumber: string | null;
  readonly matchScore: number | null;
  readonly candidates: readonly Candidate[];
}

interface ReconciliationView {
  readonly statement: {
    id: string;
    statementRef: string;
    accountCode: string;
    accountNameAr: string;
    periodStart: string;
    periodEnd: string;
    openingBalance: string;
    closingBalance: string;
    isReconciled: boolean;
    reconciledAt: string | null;
  };
  readonly lines: readonly ReconciliationLine[];
  readonly unmatchedPayments: readonly {
    id: string;
    voucherNumber: string;
    type: 'RECEIPT' | 'PAYMENT';
    paymentDate: string;
    amount: string;
    counterpartyName: string;
  }[];
  readonly summary: {
    bankClosingBalance: string;
    bookBalance: string;
    statementOnlyNet: string;
    booksOnlyNet: string;
    reconciledPerBank: string;
    reconciledPerBooks: string;
    difference: string;
    isBalanced: boolean;
    matchedLines: number;
    unmatchedLines: number;
    unmatchedPayments: number;
  };
}

export function BankReconciliation(): JSX.Element {
  const [statements, setStatements] = useState<readonly StatementListItem[]>([]);
  const [statementId, setStatementId] = useState('');
  const [view, setView] = useState<ReconciliationView | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{ items: StatementListItem[] }>('/api/treasury/reconciliation').then((result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatements(result.data.items);
      // Opening straight onto the first statement that still needs work is the common
      // intent; a picker that starts empty makes everyone do the same click.
      const pending = result.data.items.find((item) => !item.isReconciled);
      if (pending !== undefined) setStatementId(pending.id);
    });
  }, []);

  const load = useCallback(async (id: string): Promise<void> => {
    if (id === '') {
      setView(null);
      return;
    }

    setLoading(true);
    const result = await apiFetch<ReconciliationView>(`/api/treasury/reconciliation/${id}`);
    setLoading(false);

    if (!result.ok) {
      setError(result.error);
      setView(null);
      return;
    }

    setError(null);
    setView(result.data);
  }, []);

  useEffect(() => {
    void load(statementId);
  }, [statementId, load]);

  async function act(
    action: 'match' | 'unmatch' | 'auto',
    payload: Record<string, string> = {},
    // Per-row rather than global, so only the button that was pressed shows a spinner:
    // one busy flag on a table of forty rows spins all forty.
    busyKey: string = action,
  ): Promise<void> {
    setBusy(busyKey);
    setError(null);
    setNotice(null);

    const result = await apiPost<
      | { action: 'match'; lineId: string; score: number }
      | { action: 'unmatch'; lineId: string }
      | { action: 'auto'; matched: number; ambiguous: number; unmatched: number }
    >(`/api/treasury/reconciliation/${statementId}/match`, { action, ...payload });

    setBusy(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (result.data.action === 'auto') {
      const { matched, ambiguous, unmatched } = result.data;
      setNotice(
        ambiguous > 0
          ? `طُوبقت ${matched} حركة آلياً. ${ambiguous} حركة لها أكثر من احتمال متساوٍ — تحتاج قراراً بشرياً. ${unmatched} حركة غير مطابقة.`
          : `طُوبقت ${matched} حركة آلياً. ${unmatched} حركة غير مطابقة.`,
      );
    }

    await load(statementId);
  }

  async function finalise(action: 'finalise' | 'reopen'): Promise<void> {
    setBusy(action);
    setError(null);
    setNotice(null);

    const result = await apiPost(`/api/treasury/reconciliation/${statementId}/finalise`, { action });
    setBusy(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setNotice(action === 'finalise' ? 'تم اعتماد الكشف كمُطابَق.' : 'أُعيد فتح الكشف للتعديل.');
    await load(statementId);
  }

  const currency = 'SAR';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="كشف الحساب" description="اختر الكشف البنكي المطلوب تسويته" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="الكشف" required className="sm:col-span-2">
            <Select
              placeholder="اختر كشف حساب"
              value={statementId}
              onChange={(event) => setStatementId(event.target.value)}
              options={statements.map((statement) => ({
                value: statement.id,
                label: `${statement.accountCode} · ${statement.statementRef} · ${statement.periodStart} → ${statement.periodEnd}${
                  statement.isReconciled ? ' (مُعتمد)' : ` (${statement.unmatchedLines} غير مطابق)`
                }`,
              }))}
            />
          </Field>
        </CardBody>
      </Card>

      {error !== null ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error.messageAr}
        </div>
      ) : null}

      {notice !== null ? (
        <div role="status" className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">جارٍ تحميل الكشف…</p>
        </Card>
      ) : null}

      {view === null && !loading ? (
        <Card className="p-12 text-center">
          <p className="text-sm text-muted-foreground">اختر كشف حساب لبدء التسوية.</p>
        </Card>
      ) : null}

      {view !== null && !loading ? (
        <>
          {/* The one number the whole screen exists to produce. */}
          <div
            role="status"
            aria-live="polite"
            className={
              view.summary.isBalanced
                ? 'rounded-lg border border-success/30 bg-success/10 px-4 py-3'
                : 'rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3'
            }
          >
            <div className="flex items-start gap-3">
              {view.summary.isBalanced ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className={view.summary.isBalanced ? 'text-sm font-medium text-success' : 'text-sm font-medium text-destructive'}>
                  {view.summary.isBalanced
                    ? 'الكشف مطابق — لا يوجد فرق غير مُفسَّر'
                    : `يوجد فرق غير مُفسَّر بمقدار ${formatMoney(view.summary.difference, { currency })}`}
                </p>

                <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <Row label="الرصيد حسب البنك" value={formatMoney(view.summary.bankClosingBalance, { currency })} />
                  <Row label="الرصيد حسب الدفاتر" value={formatMoney(view.summary.bookBalance, { currency })} />
                  <Row
                    label="حركات في الكشف وليست في الدفاتر"
                    value={formatMoney(view.summary.statementOnlyNet, { currency })}
                  />
                  <Row
                    label="سندات في الدفاتر وليست في الكشف"
                    value={formatMoney(view.summary.booksOnlyNet, { currency })}
                  />
                  <Row
                    label="المُطابَق حسب البنك"
                    value={formatMoney(view.summary.reconciledPerBank, { currency })}
                    emphasise
                  />
                  <Row
                    label="المُطابَق حسب الدفاتر"
                    value={formatMoney(view.summary.reconciledPerBooks, { currency })}
                    emphasise
                  />
                </dl>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {view.summary.matchedLines} مطابق · {view.summary.unmatchedLines} غير مطابق ·{' '}
              {view.summary.unmatchedPayments} سند غير ظاهر في الكشف
            </p>

            <div className="flex flex-wrap gap-2">
              {view.statement.isReconciled ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy === 'reopen'}
                  onClick={() => void finalise('reopen')}
                >
                  إعادة فتح الكشف
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={busy === 'auto'}
                    onClick={() => void act('auto')}
                  >
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    مطابقة آلية
                  </Button>
                  <Button
                    size="sm"
                    loading={busy === 'finalise'}
                    // Disabled rather than hidden: the user should see that sign-off exists
                    // and that the difference is what stands between them and it.
                    disabled={!view.summary.isBalanced}
                    onClick={() => void finalise('finalise')}
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    اعتماد التسوية
                  </Button>
                </>
              )}
            </div>
          </div>

          <Card>
            <CardHeader
              title={`حركات الكشف — ${view.statement.accountNameAr}`}
              description={`${view.statement.statementRef} · ${view.statement.periodStart} إلى ${view.statement.periodEnd}`}
              action={
                view.statement.isReconciled ? (
                  <Badge tone="success">مُعتمد</Badge>
                ) : (
                  <Badge tone="warning">قيد التسوية</Badge>
                )
              }
            />

            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">التاريخ</th>
                    <th scope="col">الوصف</th>
                    <th scope="col" className="numeric">وارد</th>
                    <th scope="col" className="numeric">صادر</th>
                    <th scope="col">المطابقة</th>
                  </tr>
                </thead>
                <tbody>
                  {view.lines.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-16 text-center text-muted-foreground">
                        لا توجد حركات في هذا الكشف
                      </td>
                    </tr>
                  ) : (
                    view.lines.map((line) => (
                      <tr key={line.id} className={line.matchedPaymentId !== null ? 'bg-success/5' : undefined}>
                        <td className="whitespace-nowrap">{formatDate(line.valueDate)}</td>
                        <td className="max-w-sm">
                          <span className="block truncate">{line.description}</span>
                          {line.reference !== null ? (
                            <span className="bidi-isolate font-mono text-xs text-muted-foreground">
                              {line.reference}
                            </span>
                          ) : null}
                        </td>
                        {/* Two columns rather than a signed number: direction is a fact
                            about the movement, not a sign on its size. */}
                        <td className="numeric text-success">
                          {line.direction === 'IN' ? formatMoney(line.debit, { currency, showCurrency: false }) : null}
                        </td>
                        <td className="numeric text-destructive">
                          {line.direction === 'OUT' ? formatMoney(line.credit, { currency, showCurrency: false }) : null}
                        </td>
                        <td className="min-w-[18rem]">
                          {line.matchedPaymentId !== null ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-2 text-xs">
                                <Link2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                                <span className="bidi-isolate font-mono">{line.matchedVoucherNumber}</span>
                              </span>
                              {view.statement.isReconciled ? null : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  loading={busy === `unmatch:${line.id}`}
                                  onClick={() => void act('unmatch', { lineId: line.id }, `unmatch:${line.id}`)}
                                  aria-label="إلغاء المطابقة"
                                >
                                  <Link2Off className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          ) : view.statement.isReconciled ? (
                            <span className="text-xs text-muted-foreground">غير مطابق</span>
                          ) : line.candidates.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              لا يوجد سند بنفس المبلغ والاتجاه
                            </span>
                          ) : (
                            <ul className="space-y-1">
                              {line.candidates.map((candidate) => (
                                <li key={candidate.paymentId} className="flex items-center justify-between gap-2">
                                  <span className="min-w-0 text-xs">
                                    <span className="bidi-isolate font-mono">{candidate.voucherNumber}</span>
                                    <span className="ms-2 text-muted-foreground">
                                      {candidate.counterpartyName}
                                    </span>
                                    {/* The score's reasons, so a suggestion can be judged
                                        rather than trusted. */}
                                    <span className="ms-2 text-muted-foreground">
                                      · {candidate.score}% — {candidate.reasonsAr.join(' · ')}
                                    </span>
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    loading={busy === `match:${line.id}:${candidate.paymentId}`}
                                    onClick={() =>
                                      void act(
                                        'match',
                                        { lineId: line.id, paymentId: candidate.paymentId },
                                        `match:${line.id}:${candidate.paymentId}`,
                                      )
                                    }
                                  >
                                    مطابقة
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {view.unmatchedPayments.length > 0 ? (
            <Card>
              <CardHeader
                title="سندات في الدفاتر ولم تظهر في الكشف"
                description="شيكات لم تُقدَّم بعد أو إيداعات في الطريق — تُفسِّر جزءاً من الفرق"
              />
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">التاريخ</th>
                      <th scope="col">السند</th>
                      <th scope="col">الطرف</th>
                      <th scope="col">النوع</th>
                      <th scope="col" className="numeric">المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.unmatchedPayments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="whitespace-nowrap">{formatDate(payment.paymentDate)}</td>
                        <td>
                          <span className="bidi-isolate font-mono text-xs text-primary">
                            {payment.voucherNumber}
                          </span>
                        </td>
                        <td className="max-w-xs truncate">{payment.counterpartyName}</td>
                        <td className="text-xs">{payment.type === 'RECEIPT' ? 'قبض' : 'صرف'}</td>
                        <td className="numeric">
                          {formatMoney(payment.amount, { currency, showCurrency: false })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  emphasise = false,
}: {
  label: string;
  value: string;
  emphasise?: boolean;
}): JSX.Element {
  return (
    <div className={emphasise ? 'flex items-center justify-between font-medium' : 'flex items-center justify-between'}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="numeric">{value}</dd>
    </div>
  );
}
