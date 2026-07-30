'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  MANUAL_JOURNAL_TYPES,
  MANUAL_JOURNAL_TYPE_LABELS_AR,
} from '@/lib/domain/accounting/manual-journal';
import { DraftBanner } from '@/components/ui/draft-banner';
import { useDraftAutosave, useOnlineStatus } from '@/lib/offline/hooks';
import { submitOrQueue } from '@/lib/offline/sync';
import { apiFetch, type ApiError } from '@/lib/utils/api-client';
import { formatMoney } from '@/lib/utils/format';
import {
  isJournalLineContradictory,
  summariseJournal,
  type DraftJournalLine,
} from '@/lib/utils/journal-draft';

/**
 * Manual journal entry.
 *
 * The banner is the screen. An accountant raising an entry by hand is answering one
 * question over and over — does this balance yet — and the difference has to be
 * visible without adding up two columns by eye. So the running totals sit above the
 * grid, in exact scale-4 arithmetic, and the submit button is disabled until they
 * agree.
 *
 * Disabled rather than "submit and let the server say no": the server *will* say no,
 * because `JournalEntryDraft.validate()` refuses an unbalanced entry and PostgreSQL
 * refuses it again behind that. Sending it anyway would just turn a visible arithmetic
 * problem into a round trip and a red box.
 */

interface FormOptions {
  readonly branches: { id: string; code: string; nameAr: string }[];
  readonly accounts: { id: string; code: string; nameAr: string; type: string }[];
  readonly functionalCurrency: string;
}

let nextLineId = 0;
function blankLine(): DraftJournalLine {
  nextLineId += 1;
  return { id: `jl-${nextLineId}`, accountId: '', debit: '', credit: '', descriptionAr: '' };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function JournalEntryForm(): JSX.Element {
  const router = useRouter();

  const [options, setOptions] = useState<FormOptions | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [type, setType] = useState<string>('GENERAL');
  const [date, setDate] = useState(today());
  const [descriptionAr, setDescriptionAr] = useState('');
  const [branchId, setBranchId] = useState('');
  const [postImmediately, setPostImmediately] = useState(false);
  // Two lines to begin with, because an entry needs two and starting with one
  // suggests otherwise.
  const [lines, setLines] = useState<DraftJournalLine[]>([blankLine(), blankLine()]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [queued, setQueued] = useState(false);

  const online = useOnlineStatus();

  const draftState = useMemo(
    () => ({ type, date, descriptionAr, branchId, postImmediately, lines }),
    [type, date, descriptionAr, branchId, postImmediately, lines],
  );

  const draft = useDraftAutosave('journal-entry', draftState);

  function restoreDraft(): void {
    const state = draft.recovered?.state;
    if (state === undefined) return;

    setType(state.type);
    setDate(state.date);
    setDescriptionAr(state.descriptionAr);
    setBranchId(state.branchId);
    setPostImmediately(state.postImmediately);
    setLines(state.lines);
    draft.dismissRecovered();
  }

  useEffect(() => {
    void apiFetch<FormOptions>('/api/master-data/form-options').then((result) => {
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setOptions(result.data);
    });
  }, []);

  const balance = useMemo(() => summariseJournal(lines), [lines]);
  const currency = options?.functionalCurrency ?? 'SAR';

  const descriptionMissing = descriptionAr.trim() === '';
  const canSubmit = balance.isBalanced && !descriptionMissing && !submitting;

  function updateLine(id: string, patch: Partial<DraftJournalLine>): void {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  /**
   * Typing in one side clears the other.
   *
   * A line cannot be both, and the domain rejects one that is. Clearing as they type
   * is gentler than letting them fill both and then telling them off for it.
   */
  function setAmount(id: string, side: 'debit' | 'credit', value: string): void {
    updateLine(id, side === 'debit' ? { debit: value, credit: '' } : { credit: value, debit: '' });
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setAttempted(true);
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    const result = await submitOrQueue<{ journalId: string; entryNumber: string }>(
      'journal-entry',
      '/api/finance/journals',
      {
        type,
        date,
        descriptionAr: descriptionAr.trim(),
        ...(branchId !== '' ? { branchId } : {}),
        postImmediately,
        lines: lines
          .filter((line) => line.accountId !== '')
          .map((line) => ({
            accountId: line.accountId,
            ...(line.debit.trim() !== '' ? { debit: line.debit.trim() } : {}),
            ...(line.credit.trim() !== '' ? { credit: line.credit.trim() } : {}),
            ...(line.descriptionAr.trim() !== ''
              ? { descriptionAr: line.descriptionAr.trim() }
              : {}),
          })),
      },
    );

    if (result.outcome === 'refused') {
      setError({ code: result.code, messageAr: result.messageAr, messageEn: result.messageAr });
      setSubmitting(false);
      return;
    }

    draft.discard();

    if (result.outcome === 'queued') {
      setQueued(true);
      setSubmitting(false);
      return;
    }

    router.refresh();
    router.push('/finance/trial-balance');
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
        <p className="text-sm text-muted-foreground">جارٍ تحميل دليل الحسابات…</p>
      </Card>
    );
  }

  const accountOptions = options.accounts.map((account) => ({
    value: account.id,
    label: `${account.code} — ${account.nameAr}`,
  }));

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
          <span className="font-medium">تم حفظ القيد في طابور الإرسال.</span>{' '}
          <span className="text-muted-foreground">
            لم يُسجَّل في الدفتر بعد ولم يُخصَّص له رقم — سيتم إرساله تلقائياً عند عودة
            الاتصال.
          </span>
        </div>
      ) : null}

      {/* The answer to the only question this screen exists to answer, kept at the
          top where it is legible without scrolling past the grid. */}
      <div
        role="status"
        aria-live="polite"
        className={
          balance.isBalanced
            ? 'flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3'
            : 'flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3'
        }
      >
        {balance.isBalanced ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <div className="min-w-0 text-sm">
          <p className={balance.isBalanced ? 'font-medium text-success' : 'font-medium text-destructive'}>
            {balance.isBalanced ? 'القيد متوازن وجاهز للحفظ' : balance.blockingReason}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            مدين <span className="numeric">{formatMoney(balance.totalDebit, { currency })}</span>
            {' · '}
            دائن <span className="numeric">{formatMoney(balance.totalCredit, { currency })}</span>
          </p>
        </div>
      </div>

      <Card>
        <CardHeader title="بيانات القيد" description="النوع والتاريخ والوصف" />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="نوع القيد" required>
            <Select
              value={type}
              onChange={(event) => setType(event.target.value)}
              options={MANUAL_JOURNAL_TYPES.map((entry) => ({
                value: entry,
                label: MANUAL_JOURNAL_TYPE_LABELS_AR[entry],
              }))}
            />
          </Field>

          <Field label="التاريخ" required>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>

          <Field label="الفرع" hint="اختياري">
            <Select
              placeholder="بدون فرع"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              options={options.branches.map((branch) => ({
                value: branch.id,
                label: `${branch.code} — ${branch.nameAr}`,
              }))}
            />
          </Field>

          <Field
            label="الوصف"
            required
            className="sm:col-span-2 lg:col-span-4"
            error={attempted && descriptionMissing ? 'الوصف مطلوب.' : undefined}
            hint="ما يقرأه المدقق بعد سنة ليفهم سبب هذا القيد"
          >
            <Input
              value={descriptionAr}
              onChange={(event) => setDescriptionAr(event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="البنود" description="كل بند مدين أو دائن — لا الاثنان معاً" />

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col" className="w-8">
                  #
                </th>
                <th scope="col" className="min-w-[18rem]">
                  الحساب
                </th>
                <th scope="col" className="numeric w-36">
                  مدين
                </th>
                <th scope="col" className="numeric w-36">
                  دائن
                </th>
                <th scope="col" className="min-w-[12rem]">
                  البيان
                </th>
                <th scope="col" className="w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const contradictory = isJournalLineContradictory(line);

                return (
                  <tr key={line.id} className={contradictory ? 'bg-destructive/5' : undefined}>
                    <td className="numeric text-xs text-muted-foreground">{index + 1}</td>
                    <td>
                      <Select
                        placeholder="اختر الحساب"
                        value={line.accountId}
                        invalid={contradictory}
                        onChange={(event) => updateLine(line.id, { accountId: event.target.value })}
                        options={accountOptions}
                        aria-label={`حساب البند ${index + 1}`}
                      />
                    </td>
                    <td>
                      <Input
                        numeric
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.debit}
                        invalid={contradictory}
                        onChange={(event) => setAmount(line.id, 'debit', event.target.value)}
                        aria-label={`مدين البند ${index + 1}`}
                      />
                    </td>
                    <td>
                      <Input
                        numeric
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.credit}
                        invalid={contradictory}
                        onChange={(event) => setAmount(line.id, 'credit', event.target.value)}
                        aria-label={`دائن البند ${index + 1}`}
                      />
                    </td>
                    <td>
                      <Input
                        value={line.descriptionAr}
                        onChange={(event) =>
                          updateLine(line.id, { descriptionAr: event.target.value })
                        }
                        aria-label={`بيان البند ${index + 1}`}
                      />
                    </td>
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        // Two is the floor: an entry needs both sides, so removing
                        // below two can only produce something invalid.
                        disabled={lines.length <= 2}
                        onClick={() =>
                          setLines((current) => current.filter((entry) => entry.id !== line.id))
                        }
                        aria-label={`حذف البند ${index + 1}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                <td colSpan={2} className="px-4 py-3">
                  الإجمالي
                </td>
                <td className="numeric px-4 py-3">{balance.totalDebit}</td>
                <td className="numeric px-4 py-3">{balance.totalCredit}</td>
                <td colSpan={2} className="px-4 py-3 text-xs text-muted-foreground">
                  {balance.isBalanced ? 'متوازن' : `الفرق ${balance.difference}`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <CardBody className="border-t border-border">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((current) => [...current, blankLine()])}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            إضافة بند
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={postImmediately}
              onChange={(event) => setPostImmediately(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input"
            />
            <span>
              ترحيل القيد فوراً
              <span className="mt-0.5 block text-xs text-muted-foreground">
                القيد المُرحَّل يصبح جزءاً من التاريخ ولا يمكن تعديله أو حذفه — يُعالج
                بقيد عكسي فقط. اتركه فارغاً لحفظه كمسودة.
              </span>
            </span>
          </label>

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error.messageAr}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push('/finance/trial-balance')}
            >
              إلغاء
            </Button>
            <Button type="submit" loading={submitting} disabled={!canSubmit}>
              {postImmediately ? 'حفظ وترحيل' : 'حفظ كمسودة'}
            </Button>
          </div>

          {!online || draft.savedAt !== null ? (
            <p className="text-end text-xs text-muted-foreground">
              {draft.savedAt !== null
                ? draft.durable
                  ? 'المسودة محفوظة على هذا الجهاز'
                  : 'المسودة محفوظة في هذه النافذة فقط'
                : null}
              {!online ? <> · لا يوجد اتصال — سيُرسل عند العودة</> : null}
            </p>
          ) : null}
        </CardBody>
      </Card>
    </form>
  );
}
