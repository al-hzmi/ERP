'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import {
  FIELD_LABELS_AR,
  OPERATOR_LABELS_AR,
  fieldUnit,
  type ConditionField,
  type ConditionOperator,
} from '@/lib/domain/approvals/rule-evaluator';
import type { ApprovalRuleRow } from '@/lib/application/services/approval-rules-service';

/**
 * The rules builder.
 *
 * A rule reads as one sentence — *أمر بيع، الإجمالي أكبر من 50,000، يعتمده المدير المالي* —
 * and the form is laid out as that sentence rather than as a table of fields. The preview line
 * under the form restates what is about to be saved in the same words the rule list will use,
 * because the failure mode of a rules engine is a rule that does something other than what its
 * author believed, and reading it back is the cheapest guard against that.
 *
 * ## Two things the form refuses, and why they are refused here rather than explained later
 *
 * **A rule with no approvers.** It would raise a request nobody can action and hold every
 * matching document forever. The service refuses it too — this is the copy that turns a
 * runtime dead end into a disabled button.
 *
 * **Two conditions on the same field.** They would be ANDed into a range the builder cannot
 * display and the reader cannot see: `> 50000 AND < 10000` is a rule that silently never
 * fires. The database has a unique index saying the same thing.
 *
 * Conditions are ANDed, and the form says so out loud — a builder that quietly ORs what the
 * user reads as "and" is worse than one that offers no second condition at all.
 */

const FIELDS: ConditionField[] = [
  'TOTAL_AMOUNT',
  'SUBTOTAL',
  'TAX_AMOUNT',
  'LINE_COUNT',
  'MAX_LINE_DISCOUNT_PERCENT',
  // Counterparty facts (migration 014). These are what make a credit hold expressible:
  // "block a sales order for a customer more than 60 days overdue" is not a fact about the
  // order, so it could not be written at all before these existed.
  'OVERDUE_DAYS',
  'OVERDUE_AMOUNT',
  'CREDIT_EXPOSURE_PERCENT',
];

const OPERATORS: ConditionOperator[] = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'];

interface DraftCondition {
  readonly key: string;
  field: ConditionField;
  operator: ConditionOperator;
  value: string;
}

function emptyCondition(): DraftCondition {
  return { key: crypto.randomUUID(), field: 'TOTAL_AMOUNT', operator: 'GT', value: '' };
}

export function RulesBuilder({
  rules,
  documentTypes,
  roles,
  canEdit,
}: {
  rules: readonly ApprovalRuleRow[];
  documentTypes: readonly { value: string; label: string }[];
  roles: readonly { id: string; nameAr: string; name: string }[];
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [documentType, setDocumentType] = useState(documentTypes[0]?.value ?? 'SALES_ORDER');
  const [priority, setPriority] = useState('100');
  const [conditions, setConditions] = useState<DraftCondition[]>([emptyCondition()]);
  const [approverRoleIds, setApproverRoleIds] = useState<string[]>(['']);
  const [excludeInitiator, setExcludeInitiator] = useState(true);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filledConditions = conditions.filter((condition) => condition.value.trim() !== '');
  const chosenApprovers = approverRoleIds.filter((id) => id !== '');

  const duplicateField =
    new Set(filledConditions.map((condition) => condition.field)).size !==
    filledConditions.length;
  const duplicateApprover = new Set(chosenApprovers).size !== chosenApprovers.length;

  const canSubmit =
    nameAr.trim() !== '' &&
    nameEn.trim() !== '' &&
    chosenApprovers.length > 0 &&
    !duplicateField &&
    !duplicateApprover;

  function updateCondition(key: string, patch: Partial<DraftCondition>): void {
    setConditions((previous) =>
      previous.map((condition) => (condition.key === key ? { ...condition, ...patch } : condition)),
    );
  }

  async function send(
    payload: Record<string, unknown>,
    key: string,
    success: string,
    reset?: () => void,
  ): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/system/approval-rules', payload);
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    reset?.();
    setNotice(success);
    router.refresh();
  }

  // The sentence the rule will read as, restated from what is on screen right now.
  const preview = (() => {
    const type = documentTypes.find((candidate) => candidate.value === documentType)?.label ?? '';
    const clauses = filledConditions.map((condition) => {
      const unit = fieldUnit(condition.field);
      const suffix = unit === 'percent' ? '%' : unit === 'count' ? ' سطر' : '';
      return `${FIELD_LABELS_AR[condition.field]} ${OPERATOR_LABELS_AR[condition.operator]} ${condition.value}${suffix}`;
    });
    const signers = chosenApprovers
      .map((id) => roles.find((role) => role.id === id)?.nameAr ?? '')
      .filter((name) => name !== '');

    const when = clauses.length === 0 ? 'أي مستند' : clauses.join(' و');
    const who = signers.length === 0 ? '—' : signers.join(' ثم ');
    return `عند تأكيد ${type}: إذا كان ${when} — يُوقَف حتى يعتمده ${who}.`;
  })();

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

      {canEdit ? (
        <Card>
          <CardHeader
            title="قاعدة جديدة"
            description="الشروط تُجمَع بـ«و» — كلها يجب أن تتحقق. للتعبير عن «أو» أنشئ قاعدتين، فيبقى سبب الإيقاف واضحاً في السجل."
          />
          <CardBody className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="اسم القاعدة" required>
                <Input
                  value={nameAr}
                  placeholder="مثال: أوامر البيع الكبيرة"
                  onChange={(event) => setNameAr(event.target.value)}
                />
              </Field>
              <Field label="الاسم بالإنجليزية" required>
                <Input
                  dir="ltr"
                  value={nameEn}
                  onChange={(event) => setNameEn(event.target.value)}
                />
              </Field>
              <Field label="نوع المستند" required>
                <Select
                  value={documentType}
                  options={documentTypes.map((type) => ({ value: type.value, label: type.label }))}
                  onChange={(event) => setDocumentType(event.target.value)}
                />
              </Field>
              <Field label="الأولوية" hint="الأقل يُطبَّق أولاً عند تطابق أكثر من قاعدة">
                <Input
                  numeric
                  inputMode="numeric"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                />
              </Field>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">الشروط</p>
              {conditions.map((condition) => (
                // `Select` and `Input` are `w-full` by design, so each sits in a sized
                // wrapper. Setting a width on the control itself loses to the base class and
                // the row stacks into three lines — which is what it did before this.
                <div key={condition.key} className="flex flex-wrap items-end gap-2">
                  <div className="w-52">
                    <Select
                      value={condition.field}
                      options={FIELDS.map((field) => ({
                        value: field,
                        label: FIELD_LABELS_AR[field],
                      }))}
                      onChange={(event) =>
                        updateCondition(condition.key, {
                          field: event.target.value as ConditionField,
                        })
                      }
                    />
                  </div>
                  <div className="w-44">
                    <Select
                      value={condition.operator}
                      options={OPERATORS.map((operator) => ({
                        value: operator,
                        label: OPERATOR_LABELS_AR[operator],
                      }))}
                      onChange={(event) =>
                        updateCondition(condition.key, {
                          operator: event.target.value as ConditionOperator,
                        })
                      }
                    />
                  </div>
                  <div className="w-36">
                    <Input
                      numeric
                      inputMode="decimal"
                      value={condition.value}
                      placeholder={fieldUnit(condition.field) === 'percent' ? '15' : '50000'}
                      onChange={(event) =>
                        updateCondition(condition.key, { value: event.target.value })
                      }
                    />
                  </div>
                  <span className="pb-2 text-xs text-muted-foreground">
                    {fieldUnit(condition.field) === 'percent'
                      ? '%'
                      : fieldUnit(condition.field) === 'count'
                        ? 'سطر'
                        : fieldUnit(condition.field) === 'days'
                          ? 'يوم'
                          : 'ريال'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={conditions.length === 1}
                    onClick={() =>
                      setConditions((previous) =>
                        previous.filter((other) => other.key !== condition.key),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">حذف الشرط</span>
                  </Button>
                </div>
              ))}

              {duplicateField ? (
                <p role="alert" className="text-xs text-destructive">
                  لا يمكن وضع شرطين على نفس الحقل — سيُجمعان بـ«و» فينتج مدى لا يتحقق أبداً.
                </p>
              ) : null}

              <Button
                variant="outline"
                size="sm"
                disabled={conditions.length >= 5}
                onClick={() => setConditions((previous) => [...previous, emptyCondition()])}
              >
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                إضافة شرط
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">
                سلسلة الاعتماد — بالترتيب
              </p>
              {approverRoleIds.map((roleId, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <span className="pb-2 text-xs text-muted-foreground">{index + 1}.</span>
                  <div className="w-80">
                    <Select
                      value={roleId}
                      placeholder="اختر دوراً…"
                      options={roles.map((role) => ({
                        value: role.id,
                        label: `${role.nameAr} (${role.name})`,
                      }))}
                      onChange={(event) =>
                        setApproverRoleIds((previous) =>
                          previous.map((other, position) =>
                            position === index ? event.target.value : other,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={approverRoleIds.length === 1}
                    onClick={() =>
                      setApproverRoleIds((previous) =>
                        previous.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">حذف المعتمِد</span>
                  </Button>
                </div>
              ))}

              {duplicateApprover ? (
                <p role="alert" className="text-xs text-destructive">
                  لا يمكن تكرار نفس الدور في السلسلة.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={approverRoleIds.length >= 5}
                  onClick={() => setApproverRoleIds((previous) => [...previous, ''])}
                >
                  <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                  إضافة معتمِد
                </Button>

                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={excludeInitiator}
                    onChange={(event) => setExcludeInitiator(event.target.checked)}
                    className="h-4 w-4 rounded border-input"
                  />
                  منع مُنشئ المستند من اعتماده بنفسه (فصل المهام)
                </label>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                ستُحفظ القاعدة هكذا
              </p>
              <p className="mt-1 text-sm">{preview}</p>
            </div>

            <Button
              loading={busy === 'create'}
              disabled={!canSubmit}
              onClick={() =>
                void send(
                  {
                    action: 'create',
                    nameAr: nameAr.trim(),
                    nameEn: nameEn.trim(),
                    documentType,
                    priority: Number(priority) || 100,
                    conditions: filledConditions.map((condition) => ({
                      field: condition.field,
                      operator: condition.operator,
                      value: condition.value.trim(),
                    })),
                    approverRoleIds: chosenApprovers,
                    excludeInitiator,
                  },
                  'create',
                  'حُفظت القاعدة — ستُطبَّق على المستندات المؤكَّدة من الآن.',
                  () => {
                    setNameAr('');
                    setNameEn('');
                    setConditions([emptyCondition()]);
                    setApproverRoleIds(['']);
                  },
                )
              }
            >
              حفظ القاعدة
            </Button>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="القواعد"
          description={`${rules.length} قاعدة — لا يوجد حذف: القاعدة هي السبب المسجَّل لإيقاف مستندات سابقة`}
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">القاعدة</th>
                <th scope="col">المستند</th>
                <th scope="col">الشروط</th>
                <th scope="col">سلسلة الاعتماد</th>
                <th scope="col" className="numeric">
                  الأولوية
                </th>
                <th scope="col" className="numeric">
                  الطلبات
                </th>
                <th scope="col">الحالة</th>
                {canEdit ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 8 : 7} className="py-16 text-center text-muted-foreground">
                    لا توجد قواعد — كل المستندات تُؤكَّد مباشرة
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.id} className={rule.isActive ? undefined : 'opacity-60'}>
                    <td className="max-w-[16rem]">
                      <p className="truncate">{rule.nameAr}</p>
                      <p className="bidi-isolate truncate text-[11px] text-muted-foreground">
                        {rule.nameEn}
                      </p>
                    </td>
                    <td className="text-xs">{rule.documentTypeLabelAr}</td>
                    <td className="max-w-[20rem] text-xs text-muted-foreground">
                      {rule.conditions.length === 0 ? (
                        <span className="flex items-center gap-1.5">
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          كل المستندات
                        </span>
                      ) : (
                        rule.conditions.map((condition) => (
                          <span key={condition.id} className="block truncate">
                            {condition.describedAr}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="text-xs">
                      {rule.steps.length === 0 ? (
                        <Badge tone="danger">بلا معتمِدين</Badge>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1">
                          {rule.steps.map((step, index) => (
                            <span key={step.stepNumber} className="flex items-center gap-1">
                              {index > 0 ? (
                                <ArrowLeft
                                  className="h-3 w-3 text-muted-foreground"
                                  aria-hidden="true"
                                />
                              ) : null}
                              {step.roleNameAr}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="numeric text-muted-foreground">{rule.priority}</td>
                    <td className="numeric text-muted-foreground">{rule.requestCount}</td>
                    <td>
                      {rule.isActive ? (
                        <Badge tone="success">مفعَّلة</Badge>
                      ) : (
                        <Badge tone="neutral">موقوفة</Badge>
                      )}
                    </td>
                    {canEdit ? (
                      <td>
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busy === rule.id}
                          onClick={() =>
                            void send(
                              { action: 'setActive', id: rule.id, isActive: !rule.isActive },
                              rule.id,
                              rule.isActive
                                ? 'أُوقفت القاعدة — لن تُطبَّق على مستندات جديدة.'
                                : 'أُعيد تفعيل القاعدة.',
                            )
                          }
                        >
                          {rule.isActive ? 'إيقاف' : 'تفعيل'}
                        </Button>
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
