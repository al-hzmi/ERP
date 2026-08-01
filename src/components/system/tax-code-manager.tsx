'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Percent, Plus, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import {
  TREATMENTS,
  TREATMENT_LABELS_AR,
  TREATMENT_NOTES_AR,
  ZATCA_CATEGORY,
  type TaxCodeRow,
} from '@/lib/commercial/tax-labels';
import type { TaxTreatment } from '@prisma/client';

/**
 * Tax codes.
 *
 * ## The form asks for the treatment, then stops asking for the rate
 *
 * Choosing anything but "خاضعة للضريبة" hides the rate field, because there is only one rate it
 * could be. Leaving the box enabled and rejecting `15` afterwards would be an error message
 * where an absent control does the job — and it invites the reading that zero-rated is a rate
 * you choose rather than a treatment that fixes one.
 *
 * The exemption reason appears in its place, because ZATCA rejects a non-standard line that
 * does not say why it was not taxed, and a code created without one is a code that cannot be
 * used on an invoice.
 */
export function TaxCodeManager({
  codes,
  canEdit,
}: {
  codes: readonly TaxCodeRow[];
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [editing, setEditing] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [treatment, setTreatment] = useState<TaxTreatment>('STANDARD');
  const [rate, setRate] = useState('15');
  const [reasonAr, setReasonAr] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [isActive, setIsActive] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const standard = treatment === 'STANDARD';

  function reset(): void {
    setEditing(null);
    setCode('');
    setNameAr('');
    setNameEn('');
    setTreatment('STANDARD');
    setRate('15');
    setReasonAr('');
    setReasonCode('');
    setIsActive(true);
    setError(null);
  }

  function load(row: TaxCodeRow): void {
    setEditing(row.id);
    setCode(row.code);
    setNameAr(row.nameAr);
    setNameEn(row.nameEn);
    setTreatment(row.treatment);
    setRate(row.rate.replace(/\.00$/, ''));
    setReasonAr(row.exemptionReasonAr ?? '');
    setReasonCode(row.exemptionReasonCode ?? '');
    setIsActive(row.isActive);
    setError(null);
  }

  const blocked =
    code.trim().length < 2 ||
    nameAr.trim() === '' ||
    nameEn.trim() === '' ||
    (standard && !(Number.parseFloat(rate) > 0)) ||
    (!standard && reasonAr.trim() === '');

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await apiPost<{ id: string }>('/api/system/tax-codes', {
      action: 'save',
      ...(editing !== null ? { id: editing } : {}),
      code: code.trim().toUpperCase(),
      nameAr: nameAr.trim(),
      nameEn: nameEn.trim(),
      treatment,
      // The service forces 0 for non-standard treatments; sending the typed value anyway would
      // mean the request said one thing and the row recorded another.
      rate: standard ? rate.trim() : '0',
      exemptionReasonAr: standard ? null : reasonAr.trim(),
      exemptionReasonCode: standard ? null : reasonCode.trim() || null,
      isActive,
      sortOrder: 100,
    });

    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset();
    router.refresh();
  }

  async function makeDefault(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await apiPost<{ id: string }>('/api/system/tax-codes', {
      action: 'setDefault',
      id,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="الرموز الضريبية"
          description="تظهر في قائمة «الضريبة» على كل بند فاتورة. الرمز الافتراضي هو ما يبدأ به البند الجديد"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرمز</th>
                <th scope="col">الاسم</th>
                <th scope="col">المعالجة</th>
                <th scope="col" className="numeric">النسبة</th>
                <th scope="col">تصنيف ZATCA</th>
                <th scope="col">الحالة</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {codes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground">
                    لا توجد رموز ضريبية. أضِف رمزاً حتى تعمل قائمة الضريبة في شاشة الفواتير.
                  </td>
                </tr>
              ) : (
                codes.map((row) => (
                  <tr key={row.id} className={row.isActive ? undefined : 'opacity-50'}>
                    <td>
                      <span className="bidi-isolate font-mono text-xs font-medium">{row.code}</span>
                    </td>
                    <td>
                      <p>{row.nameAr}</p>
                      {row.exemptionReasonAr !== null ? (
                        <p className="text-[11px] text-muted-foreground">{row.exemptionReasonAr}</p>
                      ) : null}
                    </td>
                    <td className="text-xs">{TREATMENT_LABELS_AR[row.treatment]}</td>
                    <td className="numeric">{row.rate}%</td>
                    <td>
                      <span className="font-mono text-xs">{row.zatcaCode}</span>
                    </td>
                    <td>
                      {row.isDefault ? (
                        <Badge tone="info">
                          <Star className="me-1 h-3 w-3" aria-hidden="true" />
                          افتراضي
                        </Badge>
                      ) : row.isActive ? (
                        <Badge tone="success">مفعَّل</Badge>
                      ) : (
                        <Badge tone="neutral">معطَّل</Badge>
                      )}
                    </td>
                    <td>
                      {canEdit ? (
                        <div className="flex justify-end gap-1">
                          {!row.isDefault && row.isActive ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => void makeDefault(row.id)}
                            >
                              اجعله افتراضياً
                            </Button>
                          ) : null}
                          <Button type="button" variant="ghost" size="sm" onClick={() => load(row)}>
                            تعديل
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {canEdit ? (
        <Card>
          <CardHeader
            title={editing === null ? 'رمز ضريبي جديد' : `تعديل ${code}`}
            description={TREATMENT_NOTES_AR[treatment]}
            action={
              editing !== null ? (
                <Button type="button" variant="ghost" size="sm" onClick={reset}>
                  إلغاء التعديل
                </Button>
              ) : null
            }
          />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="الرمز" required hint="حروف إنجليزية وأرقام، مثل VAT15">
                <Input
                  dir="ltr"
                  value={code}
                  disabled={editing !== null}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                />
              </Field>

              <Field label="الاسم بالعربية" required>
                <Input value={nameAr} onChange={(event) => setNameAr(event.target.value)} />
              </Field>

              <Field label="الاسم بالإنجليزية" required>
                <Input dir="ltr" value={nameEn} onChange={(event) => setNameEn(event.target.value)} />
              </Field>

              <Field label="المعالجة الضريبية" required>
                <Select
                  value={treatment}
                  onChange={(event) => setTreatment(event.target.value as TaxTreatment)}
                  options={TREATMENTS.map((value) => ({
                    value,
                    label: TREATMENT_LABELS_AR[value],
                  }))}
                />
              </Field>
            </div>

            {/* The rate exists only for a standard-rated code. For every other treatment the
                rate is 0 by definition, so the field is absent rather than present-and-rejected. */}
            {standard ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="النسبة %" required hint="أكبر من صفر — وإلا فهي معالجة أخرى">
                  <Input
                    numeric
                    inputMode="decimal"
                    value={rate}
                    onChange={(event) => setRate(event.target.value)}
                  />
                </Field>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="سبب الإعفاء"
                  required
                  hint="الهيئة ترفض بنداً غير خاضع لا يذكر سبب عدم احتساب الضريبة عليه"
                >
                  <Input value={reasonAr} onChange={(event) => setReasonAr(event.target.value)} />
                </Field>
                <Field label="رمز سبب الإعفاء" hint="مثل VATEX-SA-32">
                  <Input
                    dir="ltr"
                    value={reasonCode}
                    onChange={(event) => setReasonCode(event.target.value)}
                  />
                </Field>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                مفعَّل
              </label>

              <p className="text-xs text-muted-foreground">
                تصنيف ZATCA المُشتق:{' '}
                <span className="font-mono">{ZATCA_CATEGORY[treatment]}</span> — يُكتب في ملف
                الفاتورة الإلكترونية ولا يُختار يدوياً.
              </p>
            </div>

            {error !== null ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {error.messageAr}
              </p>
            ) : null}

            <div className="flex justify-end">
              <Button onClick={save} disabled={busy || blocked}>
                {editing === null ? (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden="true" />
                )}
                {busy ? 'جارٍ الحفظ…' : editing === null ? 'إضافة الرمز' : 'حفظ التعديل'}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Percent className="h-4 w-4" aria-hidden="true" />
          عرض فقط — تعديل الرموز الضريبية يتطلب صلاحية تعديل دليل الحسابات.
        </p>
      )}
    </div>
  );
}
