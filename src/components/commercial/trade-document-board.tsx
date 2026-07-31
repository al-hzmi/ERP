'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EntityPicker } from '@/components/ui/entity-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatMoney } from '@/lib/utils/format';
import { TRADE_STATUS_LABELS_AR, TRADE_STATUS_TONES } from '@/lib/commercial/status-labels';
import type {
  TradeDocumentDefinition,
  TradeDocumentRow,
} from '@/lib/application/services/trade-document-service';
import type { TradeDocumentStatus, TradeDocumentType } from '@prisma/client';

interface DraftLine {
  readonly key: string;
  productId: string;
  productLabel: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
}

function emptyLine(): DraftLine {
  return {
    key: crypto.randomUUID(),
    productId: '',
    productLabel: '',
    quantity: '1',
    unitPrice: '',
    discountPercent: '0',
    taxRate: '15',
  };
}

/**
 * Entry and register for a quotation, sales order, purchase order or sales return.
 *
 * One component for all four, parameterised by the definition the server passes in — they are
 * the same form with different words on it, and four copies would be four places for the line
 * arithmetic to drift.
 *
 * **The posting note is rendered, not hinted.** Every one of these documents changes no
 * balance, and a screen that looks like an invoice while doing nothing an invoice does is how
 * somebody ends up believing their stock is reserved.
 *
 * The running total is computed here for feedback while typing, and again on the server, which
 * is the one that is stored. They use the same rule; if they ever disagree the server wins and
 * the register will show it.
 */
export function TradeDocumentBoard({
  type,
  definition,
  documents,
  branches,
  currency,
  canEdit,
}: {
  type: TradeDocumentType;
  definition: TradeDocumentDefinition;
  documents: readonly TradeDocumentRow[];
  branches: readonly { id: string; code: string; nameAr: string }[];
  currency: string;
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [counterpartyId, setCounterpartyId] = useState('');
  const [counterpartyLabel, setCounterpartyLabel] = useState('');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [documentDate, setDocumentDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filled = lines.filter((line) => line.productId !== '' && line.unitPrice !== '');

  const total = filled.reduce((sum, line) => {
    const gross = Number(line.quantity || '0') * Number(line.unitPrice || '0');
    const net = gross * (1 - Number(line.discountPercent || '0') / 100);
    return sum + net * (1 + Number(line.taxRate || '0') / 100);
  }, 0);

  function updateLine(key: string, patch: Partial<DraftLine>): void {
    setLines((previous) =>
      previous.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  async function create(): Promise<void> {
    setBusy('create');
    setError(null);
    setNotice(null);

    const response = await apiPost<{ documentNumber: string }>('/api/trade/documents', {
      action: 'create',
      type,
      counterpartyId,
      branchId,
      documentDate,
      expectedDate: expectedDate === '' ? null : expectedDate,
      ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
      lines: filled.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent || '0',
        taxRate: line.taxRate || '0',
      })),
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setCounterpartyId('');
    setCounterpartyLabel('');
    setExpectedDate('');
    setNotes('');
    setLines([emptyLine()]);
    setNotice(`حُفظت الوثيقة ${response.data.documentNumber} كمسودة.`);
    router.refresh();
  }

  async function move(id: string, status: TradeDocumentStatus, message: string): Promise<void> {
    setBusy(id);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/trade/documents', {
      action: 'setStatus',
      type,
      id,
      status,
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setNotice(message);
    router.refresh();
  }

  const canSubmit = counterpartyId !== '' && branchId !== '' && filled.length > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="border-s-4 border-s-muted-foreground/30 text-sm text-muted-foreground">
          {definition.postingNoteAr}
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

      {notice !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm"
        >
          {notice}
        </div>
      ) : null}

      {canEdit ? (
        <Card>
          <CardHeader
            title={`وثيقة جديدة — ${definition.titleAr}`}
            description="تُحفظ كمسودة، والسطور قابلة للتعديل حتى التأكيد فقط"
          />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={definition.counterpartyLabelAr} required>
                <EntityPicker
                  entity="counterparty"
                  value={counterpartyId}
                  valueLabel={counterpartyLabel}
                  placeholder={`ابحث عن ${definition.counterpartyLabelAr}…`}
                  onSelect={(selection) => {
                    setCounterpartyId(selection.id);
                    setCounterpartyLabel(selection.label);
                  }}
                />
              </Field>
              <Field label="الفرع" required>
                <Select
                  value={branchId}
                  placeholder="اختر فرعاً…"
                  options={branches.map((branch) => ({
                    value: branch.id,
                    label: `${branch.code} — ${branch.nameAr}`,
                  }))}
                  onChange={(event) => setBranchId(event.target.value)}
                />
              </Field>
              <Field label="التاريخ" required>
                <Input
                  type="date"
                  value={documentDate}
                  onChange={(event) => setDocumentDate(event.target.value)}
                />
              </Field>
              <Field label={definition.expectedDateLabelAr}>
                <Input
                  type="date"
                  value={expectedDate}
                  onChange={(event) => setExpectedDate(event.target.value)}
                />
              </Field>
            </div>

            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col" className="min-w-[16rem]">
                      الصنف
                    </th>
                    <th scope="col">الكمية</th>
                    <th scope="col">سعر الوحدة</th>
                    <th scope="col">خصم %</th>
                    <th scope="col">ضريبة %</th>
                    <th scope="col" className="numeric">
                      الإجمالي
                    </th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const gross = Number(line.quantity || '0') * Number(line.unitPrice || '0');
                    const net = gross * (1 - Number(line.discountPercent || '0') / 100);
                    const lineTotal = net * (1 + Number(line.taxRate || '0') / 100);

                    return (
                      <tr key={line.key}>
                        <td>
                          <EntityPicker
                            entity="product"
                            value={line.productId}
                            valueLabel={line.productLabel}
                            placeholder="ابحث عن صنف…"
                            onSelect={(selection) =>
                              updateLine(line.key, {
                                productId: selection.id,
                                productLabel: selection.label,
                              })
                            }
                          />
                        </td>
                        <td className="w-24">
                          <Input
                            numeric
                            inputMode="decimal"
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(line.key, { quantity: event.target.value })
                            }
                          />
                        </td>
                        <td className="w-32">
                          <Input
                            numeric
                            inputMode="decimal"
                            value={line.unitPrice}
                            onChange={(event) =>
                              updateLine(line.key, { unitPrice: event.target.value })
                            }
                          />
                        </td>
                        <td className="w-20">
                          <Input
                            numeric
                            inputMode="decimal"
                            value={line.discountPercent}
                            onChange={(event) =>
                              updateLine(line.key, { discountPercent: event.target.value })
                            }
                          />
                        </td>
                        <td className="w-20">
                          <Input
                            numeric
                            inputMode="decimal"
                            value={line.taxRate}
                            onChange={(event) =>
                              updateLine(line.key, { taxRate: event.target.value })
                            }
                          />
                        </td>
                        <td className="numeric font-medium">
                          {formatMoney(lineTotal.toFixed(4), { currency })}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={lines.length === 1}
                            onClick={() =>
                              setLines((previous) =>
                                previous.filter((other) => other.key !== line.key),
                              )
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="sr-only">حذف السطر</span>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((previous) => [...previous, emptyLine()])}
              >
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                إضافة سطر
              </Button>

              <Field label="ملاحظات" className="min-w-[16rem] flex-1">
                <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
              </Field>

              <div className="ms-auto text-end">
                <p className="text-xs text-muted-foreground">الإجمالي</p>
                <p className="text-lg font-semibold">
                  {formatMoney(total.toFixed(4), { currency })}
                </p>
              </div>

              <Button loading={busy === 'create'} disabled={!canSubmit} onClick={() => void create()}>
                حفظ كمسودة
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={definition.titleAr} description={`${documents.length} وثيقة`} />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرقم</th>
                <th scope="col">{definition.counterpartyLabelAr}</th>
                <th scope="col">التاريخ</th>
                <th scope="col">{definition.expectedDateLabelAr}</th>
                <th scope="col" className="numeric">
                  السطور
                </th>
                <th scope="col" className="numeric">
                  الإجمالي
                </th>
                <th scope="col">الحالة</th>
                {canEdit ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 8 : 7} className="py-16 text-center text-muted-foreground">
                    لا توجد وثائق
                  </td>
                </tr>
              ) : (
                documents.map((document) => (
                  <tr key={document.id}>
                    <td className="bidi-isolate font-mono text-xs text-primary">
                      {document.documentNumber}
                    </td>
                    <td className="max-w-[16rem]">
                      <p className="truncate">{document.counterpartyNameAr}</p>
                      <p className="bidi-isolate text-[11px] text-muted-foreground">
                        {document.counterpartyCode}
                      </p>
                    </td>
                    <td className="bidi-isolate font-mono text-xs">{document.documentDate}</td>
                    <td className="bidi-isolate font-mono text-xs text-muted-foreground">
                      {document.expectedDate ?? '—'}
                    </td>
                    <td className="numeric text-muted-foreground">{document.lineCount}</td>
                    <td className="numeric font-medium">
                      {formatMoney(document.totalAmount, { currency })}
                    </td>
                    <td>
                      <Badge tone={TRADE_STATUS_TONES[document.status]}>
                        {TRADE_STATUS_LABELS_AR[document.status]}
                      </Badge>
                    </td>
                    {canEdit ? (
                      <td className="flex gap-2">
                        {document.status === 'DRAFT' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={busy === document.id}
                            onClick={() =>
                              void move(
                                document.id,
                                'CONFIRMED',
                                'أُكِّدت الوثيقة — سطورها مجمَّدة الآن.',
                              )
                            }
                          >
                            تأكيد
                          </Button>
                        ) : null}
                        {document.status === 'CONFIRMED' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={busy === document.id}
                            onClick={() =>
                              void move(document.id, 'COMPLETED', 'أُغلقت الوثيقة كمنفَّذة.')
                            }
                          >
                            إغلاق كمنفَّذ
                          </Button>
                        ) : null}
                        {document.status === 'DRAFT' || document.status === 'CONFIRMED' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy === document.id}
                            onClick={() => void move(document.id, 'CANCELLED', 'أُلغيت الوثيقة.')}
                          >
                            إلغاء
                          </Button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
