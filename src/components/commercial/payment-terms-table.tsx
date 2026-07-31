'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import type { PaymentTermRow } from '@/lib/application/services/commercial-setup-service';

/**
 * Credit terms.
 *
 * **These are not applied to invoices, and the screen says so in a banner rather than in a
 * tooltip.** `documents.dueDate` is still whatever the invoice screen sets. A maintained list
 * that looks like it is driving due dates but is not would show up as ageing that nobody can
 * reconcile — better to state the gap than to let it be inferred.
 */
export function PaymentTermsTable({
  terms,
  canEdit,
  includeInactive,
}: {
  terms: readonly PaymentTermRow[];
  canEdit: boolean;
  includeInactive: boolean;
}): JSX.Element {
  const router = useRouter();

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [netDays, setNetDays] = useState('30');
  const [discountDays, setDiscountDays] = useState('');
  const [discountPercent, setDiscountPercent] = useState('');

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(
    payload: Record<string, unknown>,
    key: string,
    success: string,
    reset?: () => void,
  ): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/commercial/setup', payload);
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    reset?.();
    setNotice(success);
    router.refresh();
  }

  const canSubmit =
    code.trim() !== '' && nameAr.trim() !== '' && nameEn.trim() !== '' && /^\d+$/.test(netDays);

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="border-s-4 border-s-muted-foreground/30 text-sm text-muted-foreground">
          هذه القائمة مرجعية: تواريخ الاستحقاق على الفواتير لا تُشتق منها بعد، بل تُدخَل في شاشة
          الفاتورة. ربطها بالفوترة يغيّر أعمار الذمم لكل فاتورة مفتوحة، وهو قرار تشغيلي.
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
            title="إضافة شرط دفع"
            description="خصم السداد المبكر: نسبة ومهلة معاً — نسبة بلا مهلة تخفيض دائم في السعر"
          />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="الرمز" required>
              <Input value={code} onChange={(event) => setCode(event.target.value)} />
            </Field>
            <Field label="الاسم بالعربية" required>
              <Input value={nameAr} onChange={(event) => setNameAr(event.target.value)} />
            </Field>
            <Field label="الاسم بالإنجليزية" required>
              <Input dir="ltr" value={nameEn} onChange={(event) => setNameEn(event.target.value)} />
            </Field>
            <Field label="مدة السداد (يوم)" required hint="صفر = نقداً عند التسليم">
              <Input
                numeric
                inputMode="numeric"
                value={netDays}
                onChange={(event) => setNetDays(event.target.value)}
              />
            </Field>
            <Field label="مهلة الخصم (يوم)">
              <Input
                numeric
                inputMode="numeric"
                value={discountDays}
                onChange={(event) => setDiscountDays(event.target.value)}
              />
            </Field>
            <Field label="نسبة الخصم %">
              <Input
                numeric
                inputMode="decimal"
                value={discountPercent}
                onChange={(event) => setDiscountPercent(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                loading={busy === 'create'}
                disabled={!canSubmit}
                onClick={() =>
                  void send(
                    {
                      action: 'createTerm',
                      code: code.trim(),
                      nameAr: nameAr.trim(),
                      nameEn: nameEn.trim(),
                      netDays: Number(netDays),
                      discountDays: discountDays === '' ? null : Number(discountDays),
                      discountPercent: discountPercent === '' ? null : discountPercent,
                    },
                    'create',
                    'أُضيف شرط الدفع.',
                    () => {
                      setCode('');
                      setNameAr('');
                      setNameEn('');
                      setDiscountDays('');
                      setDiscountPercent('');
                    },
                  )
                }
              >
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                إضافة
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="شروط الدفع"
          description={`${terms.length} شرطاً`}
          action={
            <a
              href={`/sales/payment-terms${includeInactive ? '' : '?inactive=true'}`}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              {includeInactive ? 'إخفاء الموقوفة' : 'إظهار الموقوفة'}
            </a>
          }
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرمز</th>
                <th scope="col">الاسم</th>
                <th scope="col" className="numeric">
                  مدة السداد
                </th>
                <th scope="col">خصم السداد المبكر</th>
                <th scope="col">الحالة</th>
                {canEdit ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {terms.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 6 : 5} className="py-16 text-center text-muted-foreground">
                    لا توجد شروط دفع
                  </td>
                </tr>
              ) : (
                terms.map((term) => (
                  <tr key={term.id} className={term.isActive ? undefined : 'opacity-60'}>
                    <td className="bidi-isolate font-mono text-xs text-primary">{term.code}</td>
                    <td>
                      <p>{term.nameAr}</p>
                      <p className="bidi-isolate text-[11px] text-muted-foreground">
                        {term.nameEn}
                      </p>
                    </td>
                    <td className="numeric">
                      {term.netDays === 0 ? 'نقداً' : `${term.netDays} يوم`}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {term.discountPercent === null
                        ? '—'
                        : `${term.discountPercent}% خلال ${term.discountDays} يوم`}
                    </td>
                    <td>
                      {term.isActive ? (
                        <Badge tone="success">مفعَّل</Badge>
                      ) : (
                        <Badge tone="neutral">موقوف</Badge>
                      )}
                    </td>
                    {canEdit ? (
                      <td>
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busy === term.id}
                          onClick={() =>
                            void send(
                              { action: 'setTermActive', id: term.id, isActive: !term.isActive },
                              term.id,
                              term.isActive ? 'أُوقف الشرط.' : 'أُعيد تفعيل الشرط.',
                            )
                          }
                        >
                          {term.isActive ? 'إيقاف' : 'تفعيل'}
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
