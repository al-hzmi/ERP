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
import type {
  PriceListLineRow,
  PriceListRow,
} from '@/lib/application/services/commercial-setup-service';

/**
 * Price lists and their prices.
 *
 * **These are not read at invoicing, and the banner says so.** The invoice screen uses the
 * product's own `salePrice`. A list that looks authoritative but is not would produce invoices
 * nobody can explain — so the limitation is stated where it is read, not buried in a comment.
 *
 * The standard price sits next to each entry, because a price list whose prices match the
 * standard ones is a list with no reason to exist, and that should be visible at a glance.
 */
export function PriceListBoard({
  lists,
  selected,
  currency,
  canEdit,
}: {
  lists: readonly PriceListRow[];
  selected: (PriceListRow & { lines: readonly PriceListLineRow[] }) | null;
  currency: string;
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [validTo, setValidTo] = useState('');

  const [productId, setProductId] = useState('');
  const [productLabel, setProductLabel] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [minQuantity, setMinQuantity] = useState('1');

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

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="border-s-4 border-s-muted-foreground/30 text-sm text-muted-foreground">
          هذه قوائم مرجعية: شاشة الفاتورة ما زالت تقرأ سعر البيع من بطاقة الصنف ولا تستشير هذه
          القوائم. تفعيل التسعير الآلي يتطلب قواعد لأيّ قائمة تسبق الأخرى عند تعدُّدها، وهو قرار
          تجاري لا يُتخذ ضمناً.
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
          <CardHeader title="إنشاء قائمة أسعار" description="فترة الصلاحية مفتوحة إن تُركت النهاية فارغة" />
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
            <Field label="سارية من" required>
              <Input
                type="date"
                value={validFrom}
                onChange={(event) => setValidFrom(event.target.value)}
              />
            </Field>
            <Field label="سارية حتى">
              <Input
                type="date"
                value={validTo}
                onChange={(event) => setValidTo(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                loading={busy === 'list'}
                disabled={code.trim() === '' || nameAr.trim() === '' || nameEn.trim() === ''}
                onClick={() =>
                  void send(
                    {
                      action: 'createList',
                      code: code.trim(),
                      nameAr: nameAr.trim(),
                      nameEn: nameEn.trim(),
                      validFrom,
                      validTo: validTo === '' ? null : validTo,
                    },
                    'list',
                    'أُنشئت القائمة.',
                    () => {
                      setCode('');
                      setNameAr('');
                      setNameEn('');
                      setValidTo('');
                    },
                  )
                }
              >
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                إنشاء
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="القوائم" description={`${lists.length} قائمة`} />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرمز</th>
                <th scope="col">الاسم</th>
                <th scope="col">الصلاحية</th>
                <th scope="col" className="numeric">
                  الأصناف
                </th>
                <th scope="col">الحالة</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {lists.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-muted-foreground">
                    لا توجد قوائم أسعار
                  </td>
                </tr>
              ) : (
                lists.map((list) => (
                  <tr
                    key={list.id}
                    className={
                      list.id === selected?.id
                        ? 'bg-primary/5'
                        : list.isActive
                          ? undefined
                          : 'opacity-60'
                    }
                  >
                    <td className="bidi-isolate font-mono text-xs text-primary">{list.code}</td>
                    <td>{list.nameAr}</td>
                    <td className="bidi-isolate font-mono text-[11px] text-muted-foreground">
                      {list.validFrom} → {list.validTo ?? '∞'}
                    </td>
                    <td className="numeric text-muted-foreground">{list.lineCount}</td>
                    <td>
                      {list.isActive ? (
                        <Badge tone="success">سارية</Badge>
                      ) : (
                        <Badge tone="neutral">موقوفة</Badge>
                      )}
                    </td>
                    <td className="flex gap-2">
                      <a
                        href={`/sales/price-lists?list=${list.id}`}
                        className="rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent"
                      >
                        الأسعار
                      </a>
                      {canEdit ? (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busy === list.id}
                          onClick={() =>
                            void send(
                              { action: 'setListActive', id: list.id, isActive: !list.isActive },
                              list.id,
                              list.isActive ? 'أُوقفت القائمة.' : 'أُعيد تفعيل القائمة.',
                            )
                          }
                        >
                          {list.isActive ? 'إيقاف' : 'تفعيل'}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {selected !== null ? (
        <Card>
          <CardHeader
            title={`أسعار ${selected.nameAr}`}
            description="عمود السعر القياسي بجوار كل صنف — قائمة تطابق أسعارها القياسية لا داعي لها"
          />

          {canEdit ? (
            <CardBody className="grid gap-4 border-b border-border sm:grid-cols-2 lg:grid-cols-4">
              <Field label="الصنف" required>
                <EntityPicker
                  entity="product"
                  value={productId}
                  valueLabel={productLabel}
                  placeholder="ابحث عن صنف…"
                  onSelect={(selection) => {
                    setProductId(selection.id);
                    setProductLabel(selection.label);
                  }}
                />
              </Field>
              <Field label="السعر" required>
                <Input
                  numeric
                  inputMode="decimal"
                  value={unitPrice}
                  onChange={(event) => setUnitPrice(event.target.value)}
                />
              </Field>
              <Field label="الكمية الأدنى" hint="شريحة الكمية التي يبدأ عندها هذا السعر">
                <Input
                  numeric
                  inputMode="decimal"
                  value={minQuantity}
                  onChange={(event) => setMinQuantity(event.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  loading={busy === 'price'}
                  disabled={productId === '' || unitPrice === ''}
                  onClick={() =>
                    void send(
                      {
                        action: 'setPrice',
                        priceListId: selected.id,
                        productId,
                        unitPrice,
                        minQuantity,
                      },
                      'price',
                      'حُفظ السعر.',
                      () => {
                        setProductId('');
                        setProductLabel('');
                        setUnitPrice('');
                        setMinQuantity('1');
                      },
                    )
                  }
                >
                  <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                  حفظ السعر
                </Button>
              </div>
            </CardBody>
          ) : null}

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">الصنف</th>
                  <th scope="col" className="numeric">
                    الكمية الأدنى
                  </th>
                  <th scope="col" className="numeric">
                    سعر القائمة
                  </th>
                  <th scope="col" className="numeric">
                    السعر القياسي
                  </th>
                  {canEdit ? <th scope="col" /> : null}
                </tr>
              </thead>
              <tbody>
                {selected.lines.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canEdit ? 5 : 4}
                      className="py-16 text-center text-muted-foreground"
                    >
                      لا توجد أسعار في هذه القائمة
                    </td>
                  </tr>
                ) : (
                  selected.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <p className="bidi-isolate font-mono text-[11px] text-primary">
                          {line.productSku}
                        </p>
                        <p className="truncate">{line.productNameAr}</p>
                      </td>
                      <td className="numeric">{line.minQuantity}</td>
                      <td className="numeric font-medium">
                        {formatMoney(line.unitPrice, { currency })}
                      </td>
                      <td className="numeric text-muted-foreground">
                        {formatMoney(line.standardPrice, { currency })}
                      </td>
                      {canEdit ? (
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy === line.id}
                            onClick={() =>
                              void send(
                                { action: 'removePrice', lineId: line.id },
                                line.id,
                                'حُذف السعر.',
                              )
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="sr-only">حذف</span>
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
      ) : null}
    </div>
  );
}
