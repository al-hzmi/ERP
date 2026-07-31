'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import type { CurrencyRow, ExchangeRateRow } from '@/lib/application/services/currency-service';

/**
 * Currencies and the rates between them.
 *
 * Two tables on one screen because they are one subject: a rate is meaningless without both of
 * its currencies, and entering one immediately after the other is the actual workflow.
 *
 * **A rate is a dated fact.** Entering one for a pair and date that already has one is refused
 * rather than overwritten — re-stating history silently re-values every document translated
 * with it. The message says so rather than leaving the user to wonder why nothing happened.
 */
export function CurrencyBoard({
  currencies,
  rates,
  canEdit,
}: {
  currencies: readonly CurrencyRow[];
  rates: readonly ExchangeRateRow[];
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [symbol, setSymbol] = useState('');

  const functional = currencies.find((currency) => currency.isFunctional);
  const [rateFrom, setRateFrom] = useState('');
  const [rateTo, setRateTo] = useState(functional?.id ?? '');
  const [rateValue, setRateValue] = useState('');
  const [validOn, setValidOn] = useState(new Date().toISOString().slice(0, 10));

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const currencyOptions = currencies.map((currency) => ({
    value: currency.id,
    label: `${currency.code} — ${currency.nameAr}`,
  }));

  async function send(
    payload: Record<string, unknown>,
    key: string,
    success: string,
    reset?: () => void,
  ): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/finance/currencies', payload);
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    reset?.();
    setNotice(success);
    router.refresh();
  }

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
          <CardHeader title="إضافة عملة" description="رمز ISO 4217 من ثلاثة أحرف" />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="الرمز" required>
              <Input
                dir="ltr"
                value={code}
                maxLength={3}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
            </Field>
            <Field label="الاسم بالعربية" required>
              <Input value={nameAr} onChange={(event) => setNameAr(event.target.value)} />
            </Field>
            <Field label="الاسم بالإنجليزية" required>
              <Input dir="ltr" value={nameEn} onChange={(event) => setNameEn(event.target.value)} />
            </Field>
            <Field label="العلامة" hint="تُترك فارغة لاستخدام الرمز">
              <Input dir="ltr" value={symbol} onChange={(event) => setSymbol(event.target.value)} />
            </Field>
            <div className="flex items-end">
              <Button
                loading={busy === 'currency'}
                disabled={code.length !== 3 || nameAr.trim() === '' || nameEn.trim() === ''}
                onClick={() =>
                  void send(
                    { action: 'createCurrency', code, nameAr, nameEn, symbol, minorUnits: 2 },
                    'currency',
                    'أُضيفت العملة.',
                    () => {
                      setCode('');
                      setNameAr('');
                      setNameEn('');
                      setSymbol('');
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
          title="العملات"
          description="العملة الأساسية هي وحدة القياس التي تُمسك بها الدفاتر — تقارير المركز المالي والدخل كلها بها"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرمز</th>
                <th scope="col">الاسم</th>
                <th scope="col">العلامة</th>
                <th scope="col">الحالة</th>
                {canEdit ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {currencies.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 5 : 4} className="py-16 text-center text-muted-foreground">
                    لا توجد عملات
                  </td>
                </tr>
              ) : (
                currencies.map((currency) => (
                  <tr key={currency.id} className={currency.isActive ? undefined : 'opacity-60'}>
                    <td className="bidi-isolate font-mono text-xs text-primary">{currency.code}</td>
                    <td>
                      <p>{currency.nameAr}</p>
                      <p className="bidi-isolate text-[11px] text-muted-foreground">
                        {currency.nameEn}
                      </p>
                    </td>
                    <td className="bidi-isolate">{currency.symbol}</td>
                    <td className="space-x-1 space-x-reverse">
                      {currency.isFunctional ? <Badge tone="info">أساسية</Badge> : null}
                      {currency.isActive ? (
                        <Badge tone="success">مفعَّلة</Badge>
                      ) : (
                        <Badge tone="neutral">موقوفة</Badge>
                      )}
                    </td>
                    {canEdit ? (
                      <td className="flex gap-2">
                        {!currency.isFunctional && currency.isActive ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy === `f-${currency.id}`}
                            onClick={() =>
                              void send(
                                { action: 'setFunctional', currencyId: currency.id },
                                `f-${currency.id}`,
                                'تم اعتماد العملة الأساسية.',
                              )
                            }
                          >
                            <Star className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                            اعتماد كأساسية
                          </Button>
                        ) : null}
                        {!currency.isFunctional ? (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={busy === `a-${currency.id}`}
                            onClick={() =>
                              void send(
                                {
                                  action: 'setActive',
                                  currencyId: currency.id,
                                  isActive: !currency.isActive,
                                },
                                `a-${currency.id}`,
                                currency.isActive ? 'أُوقفت العملة.' : 'أُعيد تفعيل العملة.',
                              )
                            }
                          >
                            {currency.isActive ? 'إيقاف' : 'تفعيل'}
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

      {canEdit && currencies.length > 1 ? (
        <Card>
          <CardHeader
            title="تسجيل سعر صرف"
            description="السعر واقعة بتاريخ — لا يُعدَّل سعر مسجَّل، لأن تعديله يعيد تقييم كل مستند تُرجم به"
          />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="من عملة" required>
              <Select
                value={rateFrom}
                placeholder="اختر…"
                options={currencyOptions}
                onChange={(event) => setRateFrom(event.target.value)}
              />
            </Field>
            <Field label="إلى عملة" required>
              <Select
                value={rateTo}
                placeholder="اختر…"
                options={currencyOptions}
                onChange={(event) => setRateTo(event.target.value)}
              />
            </Field>
            <Field label="السعر" required hint="حتى ستة منازل عشرية">
              <Input
                numeric
                inputMode="decimal"
                value={rateValue}
                onChange={(event) => setRateValue(event.target.value)}
              />
            </Field>
            <Field label="ساري بتاريخ" required>
              <Input
                type="date"
                value={validOn}
                onChange={(event) => setValidOn(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                loading={busy === 'rate'}
                disabled={rateFrom === '' || rateTo === '' || rateValue === ''}
                onClick={() =>
                  void send(
                    {
                      action: 'recordRate',
                      fromCurrencyId: rateFrom,
                      toCurrencyId: rateTo,
                      rate: rateValue,
                      validOn,
                    },
                    'rate',
                    'سُجِّل سعر الصرف.',
                    () => setRateValue(''),
                  )
                }
              >
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                تسجيل
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="أسعار الصرف" description={`آخر ${rates.length} سعر مسجَّل`} />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الزوج</th>
                <th scope="col" className="numeric">
                  السعر
                </th>
                <th scope="col">ساري بتاريخ</th>
              </tr>
            </thead>
            <tbody>
              {rates.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-16 text-center text-muted-foreground">
                    لا توجد أسعار صرف مسجَّلة
                  </td>
                </tr>
              ) : (
                rates.map((rate) => (
                  <tr key={rate.id}>
                    <td className="bidi-isolate font-mono text-xs">
                      {rate.fromCurrency} / {rate.toCurrency}
                    </td>
                    <td className="numeric font-mono">{rate.rate}</td>
                    <td className="bidi-isolate font-mono text-xs text-muted-foreground">
                      {rate.validOn}
                    </td>
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
