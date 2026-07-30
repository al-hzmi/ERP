'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, PackageSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EntityPicker } from '@/components/ui/entity-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { apiFetch, apiPost, type ApiError } from '@/lib/utils/api-client';
import { formatMoney } from '@/lib/utils/format';

/**
 * Stock transfer and adjustment entry.
 *
 * One component for both, because they differ in three fields and share everything else —
 * product picker, warehouse, date, and the live position readout. Two components would be two
 * places for the position lookup to drift.
 *
 * **The available quantity is fetched and shown before submitting.** A transfer or write-off
 * that exceeds stock is refused by `issueStock` — and by `erp_negative_stock_guard` behind it —
 * but a refusal arriving after the user has filled six fields is a worse experience than a
 * number they could see all along. The refusal remains the control; this is the courtesy.
 *
 * **The adjustment quantity is signed.** A surplus is `5`, a shortage is `-5`, and there is no
 * separate direction control: two fields that must agree are two fields that can disagree.
 */

interface FormOptions {
  readonly branches: readonly { id: string; code: string; nameAr: string }[];
  readonly warehouses: readonly { id: string; code: string; nameAr: string; branchId: string }[];
  readonly functionalCurrency: string;
}

interface StockPosition {
  readonly quantityOnHand: string;
  readonly averageCost?: string;
  readonly warehouseCode: string;
}

interface TransferResult {
  readonly transferGroupId: string;
  readonly transferredValue: string;
}

interface AdjustmentResult {
  readonly movementNumber: string;
  readonly entryNumber: string;
  readonly value: string;
  readonly direction: 'INCREASE' | 'DECREASE';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function StockOperationForm({ mode }: { mode: 'TRANSFER' | 'ADJUSTMENT' }): JSX.Element {
  const isTransfer = mode === 'TRANSFER';

  const [options, setOptions] = useState<FormOptions | null>(null);
  const [branchId, setBranchId] = useState('');
  const [productId, setProductId] = useState('');
  const [productLabel, setProductLabel] = useState('');
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState('');

  const [position, setPosition] = useState<StockPosition | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [transferDone, setTransferDone] = useState<TransferResult | null>(null);
  const [adjustmentDone, setAdjustmentDone] = useState<AdjustmentResult | null>(null);

  useEffect(() => {
    void apiFetch<FormOptions>('/api/master-data/form-options').then((response) => {
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setOptions(response.data);
      setBranchId(response.data.branches[0]?.id ?? '');
    });
  }, []);

  // The warehouse whose position matters: the source for a transfer, the target for an
  // adjustment. Getting this backwards would show a reassuring number from the wrong place.
  const positionWarehouseId = isTransfer ? fromWarehouseId : toWarehouseId;

  useEffect(() => {
    if (productId === '' || positionWarehouseId === '') {
      setPosition(null);
      return;
    }

    let cancelled = false;

    void apiFetch<{
      items: {
        quantityOnHand: string;
        averageCost?: string;
        warehouse: { code: string };
      }[];
    }>(
      `/api/inventory/stock?productId=${productId}&warehouseId=${positionWarehouseId}&includeZero=true&pageSize=1`,
    ).then((response) => {
      if (cancelled) return;
      if (!response.ok) {
        setPosition(null);
        return;
      }
      const row = response.data.items[0];
      setPosition(
        row === undefined
          ? null
          : {
              quantityOnHand: row.quantityOnHand,
              ...(row.averageCost !== undefined ? { averageCost: row.averageCost } : {}),
              warehouseCode: row.warehouse.code,
            },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [productId, positionWarehouseId]);

  const warehousesForBranch = useMemo(
    () => (options?.warehouses ?? []).filter((warehouse) => warehouse.branchId === branchId),
    [options, branchId],
  );

  const numericQuantity = Number(quantity);
  const quantityValid = quantity.trim() !== '' && Number.isFinite(numericQuantity) && numericQuantity !== 0;
  const isDecrease = !isTransfer && numericQuantity < 0;

  const available = position === null ? null : Number(position.quantityOnHand);
  const wouldGoNegative =
    available !== null &&
    quantityValid &&
    (isTransfer ? numericQuantity > available : isDecrease && Math.abs(numericQuantity) > available);

  const needsUnitCost =
    !isTransfer &&
    quantityValid &&
    numericQuantity > 0 &&
    (position === null || Number(position.quantityOnHand) === 0);

  const canSubmit =
    branchId !== '' &&
    productId !== '' &&
    quantityValid &&
    !submitting &&
    (isTransfer
      ? fromWarehouseId !== '' && toWarehouseId !== '' && fromWarehouseId !== toWarehouseId
      : toWarehouseId !== '' && notes.trim() !== '' && (!needsUnitCost || unitCost.trim() !== ''));

  async function submit(): Promise<void> {
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setTransferDone(null);
    setAdjustmentDone(null);

    if (isTransfer) {
      const response = await apiPost<TransferResult>('/api/inventory/transfers', {
        branchId,
        productId,
        fromWarehouseId,
        toWarehouseId,
        quantity,
        date,
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
      });
      setSubmitting(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setTransferDone(response.data);
    } else {
      const response = await apiPost<AdjustmentResult>('/api/inventory/adjustments', {
        branchId,
        productId,
        warehouseId: toWarehouseId,
        quantity,
        date,
        reason: notes.trim(),
        ...(unitCost.trim() !== '' ? { unitCost: unitCost.trim() } : {}),
      });
      setSubmitting(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setAdjustmentDone(response.data);
    }

    // Keep the context, clear the entry. The next movement is usually the same branch and
    // warehouses, and re-picking them every time is the cost of a naive reset.
    setQuantity('');
    setUnitCost('');
    setNotes('');
    setPosition(null);
    setProductId('');
    setProductLabel('');
  }

  const currency = options?.functionalCurrency ?? 'SAR';

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

      {transferDone !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="font-medium text-success">
              نُفِّذ التحويل بقيمة {formatMoney(transferDone.transferredValue, { currency })}.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              حركتان مرتبطتان بمعرّف تحويل واحد — إخراج من المصدر وإدخال للوجهة. لا قيد محاسبي:
              القيمة لم تغادر المنشأة.
            </p>
          </div>
        </div>
      ) : null}

      {adjustmentDone !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="font-medium text-success">
              رُحِّلت التسوية{' '}
              <span className="bidi-isolate font-mono">{adjustmentDone.movementNumber}</span> بقيمة{' '}
              {formatMoney(adjustmentDone.value, { currency })} بالقيد{' '}
              <span className="bidi-isolate font-mono">{adjustmentDone.entryNumber}</span>.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {adjustmentDone.direction === 'INCREASE'
                ? 'مدين: المخزون · دائن: تسويات المخزون'
                : 'مدين: تسويات المخزون · دائن: المخزون'}
            </p>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title={isTransfer ? 'بيانات التحويل' : 'بيانات التسوية'}
          description={
            isTransfer
              ? 'نقل بين مستودعين — الرصيد ينتقل والقيمة تبقى داخل المنشأة'
              : 'الكمية الموجبة زيادة مكتشفة، والسالبة عجز يُشطب — ويُرحَّل الفرق للأستاذ'
          }
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="الفرع" required>
            <Select
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value);
                setFromWarehouseId('');
                setToWarehouseId('');
              }}
              placeholder="اختر الفرع"
              options={(options?.branches ?? []).map((branch) => ({
                value: branch.id,
                label: `${branch.code} · ${branch.nameAr}`,
              }))}
            />
          </Field>

          <Field label="التاريخ" required>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>

          <Field label="الصنف" required>
            <EntityPicker
              entity="product"
              value={productId}
              valueLabel={productLabel}
              onSelect={(selection) => {
                setProductId(selection.id);
                setProductLabel(selection.label);
              }}
            />
          </Field>

          {isTransfer ? (
            <>
              <Field label="من مستودع" required>
                <Select
                  value={fromWarehouseId}
                  onChange={(event) => setFromWarehouseId(event.target.value)}
                  placeholder="المستودع المصدر"
                  options={warehousesForBranch.map((warehouse) => ({
                    value: warehouse.id,
                    label: `${warehouse.code} · ${warehouse.nameAr}`,
                  }))}
                />
              </Field>
              <Field
                label="إلى مستودع"
                required
                error={
                  fromWarehouseId !== '' && fromWarehouseId === toWarehouseId
                    ? 'لا يمكن التحويل إلى المستودع نفسه'
                    : undefined
                }
              >
                <Select
                  value={toWarehouseId}
                  onChange={(event) => setToWarehouseId(event.target.value)}
                  placeholder="المستودع الوجهة"
                  options={warehousesForBranch.map((warehouse) => ({
                    value: warehouse.id,
                    label: `${warehouse.code} · ${warehouse.nameAr}`,
                  }))}
                />
              </Field>
            </>
          ) : (
            <Field label="المستودع" required>
              <Select
                value={toWarehouseId}
                onChange={(event) => setToWarehouseId(event.target.value)}
                placeholder="اختر المستودع"
                options={warehousesForBranch.map((warehouse) => ({
                  value: warehouse.id,
                  label: `${warehouse.code} · ${warehouse.nameAr}`,
                }))}
              />
            </Field>
          )}

          <Field
            label={isTransfer ? 'الكمية' : 'الكمية (سالبة للعجز)'}
            required
            error={
              wouldGoNegative
                ? `الرصيد المتاح ${position?.quantityOnHand ?? '0'} فقط`
                : undefined
            }
          >
            <Input
              numeric
              inputMode="decimal"
              placeholder={isTransfer ? '10' : '5 أو 5-'}
              value={quantity}
              invalid={wouldGoNegative}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>

          {needsUnitCost ? (
            <Field
              label="تكلفة الوحدة"
              required
              error="لا يوجد رصيد سابق في هذا المستودع، فلا توجد تكلفة يُستند إليها"
            >
              <Input
                numeric
                inputMode="decimal"
                placeholder="0.00"
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
              />
            </Field>
          ) : null}

          <Field
            label={isTransfer ? 'ملاحظات' : 'سبب التسوية'}
            required={!isTransfer}
            className="sm:col-span-2 lg:col-span-3"
          >
            <Input
              value={notes}
              placeholder={isTransfer ? 'اختياري' : 'تلف، جرد، فقد…'}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      {position !== null ? (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                الرصيد الحالي في{' '}
                <span className="bidi-isolate font-mono">{position.warehouseCode}</span>
              </span>
              <div className="flex items-center gap-4">
                <span className="numeric text-lg font-semibold">{position.quantityOnHand}</span>
                {position.averageCost !== undefined ? (
                  <Badge tone="neutral">
                    متوسط التكلفة {formatMoney(position.averageCost, { currency })}
                  </Badge>
                ) : null}
              </div>
            </div>
            {wouldGoNegative ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                الكمية المطلوبة تتجاوز المتاح — سيرفضها النظام على أي حال، وهذا تنبيه مبكر لا أكثر.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="me-auto text-xs text-muted-foreground">
          {isTransfer
            ? 'يُنفَّذ التحويل مباشرة — لا مسودة ولا اعتماد.'
            : 'تُرحَّل التسوية مباشرة إلى الأستاذ مع حركة المخزون في معاملة واحدة.'}
        </p>
        <Button loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          {isTransfer ? (
            <>
              <ArrowLeftRight className="me-1.5 h-4 w-4" aria-hidden="true" />
              تنفيذ التحويل
            </>
          ) : (
            <>
              <PackageSearch className="me-1.5 h-4 w-4" aria-hidden="true" />
              ترحيل التسوية
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
