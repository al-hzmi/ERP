'use client';

import { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EntityPicker } from '@/components/ui/entity-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiFetch, type ApiError } from '@/lib/utils/api-client';
import { formatDate, formatMoney, formatQuantity } from '@/lib/utils/format';

/**
 * The stock card: one product in one warehouse, movement by movement.
 *
 * A warehouse is required rather than optional, and that is a correctness constraint
 * rather than a simplification. The running balance comes from `balanceAfter` on each
 * movement, which the inventory service maintains per warehouse under a row lock.
 * Interleaving two warehouses' movements into one chronological list would produce a
 * balance column that jumps between two independent series — arithmetic that looks
 * broken because it is being read as something it never was.
 */

/**
 * The five movement types, and what each is called.
 *
 * Only the label comes from here. Direction is decided by the API from the balance
 * chain, because `TRANSFER` is inbound at one warehouse and outbound at the other and
 * `ADJUSTMENT` goes either way — a lookup table cannot know which.
 */
const MOVEMENT_LABELS: Record<string, string> = {
  IN: 'إدخال',
  OUT: 'إخراج',
  TRANSFER: 'تحويل',
  ADJUSTMENT: 'تسوية',
  RETURN: 'مرتجع',
};

/** The reference that produced a movement, when there is one. */
const REFERENCE_LABELS: Record<string, string> = {
  DOCUMENT: 'مستند',
  SALES_INVOICE: 'فاتورة مبيعات',
  PURCHASE_INVOICE: 'فاتورة مشتريات',
  TRANSFER: 'تحويل',
  ADJUSTMENT: 'تسوية',
};

interface Movement {
  readonly id: string;
  readonly movementNumber: string;
  readonly type: string;
  readonly movementDate: string;
  readonly quantity: string;
  readonly unitCost: string;
  readonly totalCost: string;
  readonly balanceAfter: string;
  /** Derived by the API from the balance chain, not from `type`. */
  readonly direction: 'IN' | 'OUT';
  /** The absolute change this movement made to the on-hand balance. */
  readonly delta: string;
  readonly referenceType: string | null;
  readonly batchNumber: string | null;
  readonly notes: string | null;
}

interface StockCard {
  readonly product: {
    id: string;
    sku: string;
    nameAr: string;
    costingMethod: string;
    unitCode: string;
    unitNameAr: string;
  };
  readonly warehouse: { id: string; code: string; nameAr: string };
  readonly period: { from: string; to: string };
  readonly openingBalance: string;
  readonly movements: readonly Movement[];
  readonly truncated: boolean;
  readonly current: { quantityOnHand: string; quantityReserved: string; averageCost: string };
}

interface FormOptions {
  readonly warehouses: { id: string; code: string; nameAr: string }[];
  readonly functionalCurrency: string;
}

function startOfYear(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function StockCardView(): JSX.Element {
  const [options, setOptions] = useState<FormOptions | null>(null);
  const [productId, setProductId] = useState('');
  const [productLabel, setProductLabel] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());

  const [card, setCard] = useState<StockCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void apiFetch<FormOptions>('/api/master-data/form-options').then((result) => {
      if (result.ok) setOptions(result.data);
    });
  }, []);

  // Reloads whenever the selection is complete. No "show" button: the card is the
  // answer to the selection, and a button between the two is a step that exists only
  // to be clicked.
  useEffect(() => {
    if (productId === '' || warehouseId === '') {
      setCard(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const query = new URLSearchParams({ productId, warehouseId, from, to });

    void apiFetch<StockCard>(`/api/inventory/stock-card?${query.toString()}`).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setCard(result.data);
        setError(null);
      } else {
        setCard(null);
        setError(result.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [productId, warehouseId, from, to]);

  const currency = options?.functionalCurrency ?? 'SAR';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="اختيار البطاقة" description="الصنف والمستودع والفترة" />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="الصنف" required className="sm:col-span-2">
            <EntityPicker
              entity="product"
              value={productId}
              valueLabel={productLabel}
              placeholder="ابحث بالرمز أو الاسم…"
              onSelect={(selection) => {
                setProductId(selection.id);
                setProductLabel(
                  selection.id === '' ? '' : `${selection.label} — ${selection.code}`,
                );
              }}
            />
          </Field>

          <Field
            label="المستودع"
            required
            hint="الرصيد الجاري يُحسب لكل مستودع على حدة"
            className="sm:col-span-2"
          >
            <Select
              placeholder="اختر المستودع"
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
              options={(options?.warehouses ?? []).map((warehouse) => ({
                value: warehouse.id,
                label: `${warehouse.code} — ${warehouse.nameAr}`,
              }))}
            />
          </Field>

          <Field label="من تاريخ">
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>

          <Field label="إلى تاريخ">
            <Input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </CardBody>
      </Card>

      {error !== null ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-destructive">{error.messageAr}</p>
        </Card>
      ) : null}

      {loading ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">جارٍ تحميل الحركات…</p>
        </Card>
      ) : null}

      {card === null && !loading && error === null ? (
        <Card className="p-12 text-center">
          <p className="text-sm text-muted-foreground">اختر صنفاً ومستودعاً لعرض البطاقة.</p>
        </Card>
      ) : null}

      {card !== null && !loading ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="الرصيد الحالي" value={`${formatQuantity(card.current.quantityOnHand)} ${card.product.unitNameAr}`} />
            <Stat label="المحجوز" value={formatQuantity(card.current.quantityReserved)} />
            <Stat
              label="متوسط التكلفة"
              value={formatMoney(card.current.averageCost, { currency })}
            />
            <Stat
              label="قيمة المخزون"
              value={formatMoney(
                // Displayed, not stored: the authoritative valuation is the sum of
                // cost layers, which the reports compute. This is the quick read.
                (Number(card.current.quantityOnHand) * Number(card.current.averageCost)).toFixed(2),
                { currency },
              )}
            />
          </div>

          <Card>
            <CardHeader
              title={`${card.product.nameAr} — ${card.warehouse.nameAr}`}
              description={`${card.product.sku} · طريقة التكلفة ${card.product.costingMethod === 'FIFO' ? 'الوارد أولاً صادر أولاً' : 'المتوسط المرجّح'} · وحدة ${card.product.unitNameAr}`}
              action={
                card.truncated ? (
                  <Badge tone="warning">أول 500 حركة فقط</Badge>
                ) : (
                  <Badge tone="neutral">{card.movements.length} حركة</Badge>
                )
              }
            />

            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">التاريخ</th>
                    <th scope="col">رقم الحركة</th>
                    <th scope="col">النوع</th>
                    <th scope="col" className="numeric">
                      وارد
                    </th>
                    <th scope="col" className="numeric">
                      صادر
                    </th>
                    <th scope="col" className="numeric">
                      تكلفة الوحدة
                    </th>
                    <th scope="col" className="numeric">
                      الرصيد
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-muted/30 font-medium">
                    <td colSpan={6} className="px-4 py-2 text-xs">
                      الرصيد المُدوَّر في {formatDate(card.period.from)}
                    </td>
                    <td className="numeric px-4 py-2">{formatQuantity(card.openingBalance)}</td>
                  </tr>

                  {card.movements.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-16 text-center text-muted-foreground">
                        لا توجد حركات في هذه الفترة
                      </td>
                    </tr>
                  ) : (
                    card.movements.map((movement) => {
                      const label = MOVEMENT_LABELS[movement.type] ?? movement.type;

                      return (
                        <tr key={movement.id}>
                          <td className="whitespace-nowrap">{formatDate(movement.movementDate)}</td>
                          <td>
                            <span className="bidi-isolate font-mono text-xs text-primary">
                              {movement.movementNumber}
                            </span>
                          </td>
                          <td className="text-xs">
                            {label}
                            {movement.referenceType !== null ? (
                              <span className="ms-2 text-muted-foreground">
                                {REFERENCE_LABELS[movement.referenceType] ?? movement.referenceType}
                              </span>
                            ) : null}
                            {movement.batchNumber !== null ? (
                              <span className="ms-2 text-muted-foreground">
                                دفعة {movement.batchNumber}
                              </span>
                            ) : null}
                          </td>
                          {/* Two columns rather than one signed number: a quantity in
                              this system is always positive, and direction is a fact
                              about the movement, not a sign on its size. */}
                          <td className="numeric text-success">
                            {movement.direction === 'IN' ? formatQuantity(movement.delta) : null}
                          </td>
                          <td className="numeric text-destructive">
                            {movement.direction === 'OUT' ? formatQuantity(movement.delta) : null}
                          </td>
                          <td className="numeric text-muted-foreground">
                            {formatMoney(movement.unitCost, { currency, showCurrency: false })}
                          </td>
                          <td className="numeric font-medium">
                            {formatQuantity(movement.balanceAfter)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {card.truncated ? (
              <CardBody className="border-t border-border">
                <p className="text-xs text-muted-foreground">
                  عُرضت أول 500 حركة في الفترة المحددة. ضيّق نطاق التاريخ لرؤية
                  البقية — البطاقة لا تُقصّ بصمت.
                </p>
              </CardBody>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Card>
      <CardBody>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="numeric mt-1 text-lg font-semibold">{value}</p>
      </CardBody>
    </Card>
  );
}
