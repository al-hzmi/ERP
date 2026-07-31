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
import {
  ASSEMBLY_STATUS_LABELS_AR,
  ASSEMBLY_STATUS_TONES,
} from '@/lib/commercial/status-labels';
import type { AssemblyOrderRow } from '@/lib/application/services/commercial-setup-service';

interface Component {
  readonly key: string;
  productId: string;
  productLabel: string;
  quantityPerUnit: string;
}

function emptyComponent(): Component {
  return { key: crypto.randomUUID(), productId: '', productLabel: '', quantityPerUnit: '1' };
}

/**
 * Assembly orders: what to build, from what, and how many.
 *
 * **Completing an order moves no stock, and the banner says so plainly.** Consuming the
 * components and receiving the output at a cost derived from their cost layers is real
 * inventory accounting; a half-built version would corrupt the valuation every report on the
 * system rests on. The order is a record of intent and status.
 *
 * Component quantities are *per unit of output*. The register shows the multiplied total on the
 * order detail, because "2 per unit" and "200 in total" are different numbers and a warehouse
 * needs the second one.
 */
export function AssemblyBoard({
  orders,
  warehouses,
  canEdit,
}: {
  orders: readonly AssemblyOrderRow[];
  warehouses: readonly { id: string; code: string; nameAr: string }[];
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [productId, setProductId] = useState('');
  const [productLabel, setProductLabel] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [components, setComponents] = useState<Component[]>([emptyComponent()]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filled = components.filter((component) => component.productId !== '');

  // Caught here as well as in the service and by a trigger. Three layers because this is the
  // one mistake that produces an order describing a thing made of itself.
  const selfReferential = filled.some((component) => component.productId === productId);

  function updateComponent(key: string, patch: Partial<Component>): void {
    setComponents((previous) =>
      previous.map((component) => (component.key === key ? { ...component, ...patch } : component)),
    );
  }

  async function create(): Promise<void> {
    setBusy('create');
    setError(null);
    setNotice(null);

    const response = await apiPost<{ orderNumber: string }>('/api/inventory/assemblies', {
      action: 'create',
      productId,
      quantity,
      warehouseId,
      orderDate,
      ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
      components: filled.map((component) => ({
        productId: component.productId,
        quantityPerUnit: component.quantityPerUnit,
      })),
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setProductId('');
    setProductLabel('');
    setQuantity('1');
    setNotes('');
    setComponents([emptyComponent()]);
    setNotice(`أُنشئ أمر التجميع ${response.data.orderNumber}.`);
    router.refresh();
  }

  async function move(id: string, status: 'COMPLETED' | 'CANCELLED', message: string): Promise<void> {
    setBusy(id);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/inventory/assemblies', {
      action: 'setStatus',
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

  const canSubmit =
    productId !== '' && warehouseId !== '' && filled.length > 0 && !selfReferential;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="border-s-4 border-s-muted-foreground/30 text-sm text-muted-foreground">
          أوامر التجميع تُسجَّل وتُتابَع فقط: إغلاق الأمر لا يستهلك المكوّنات ولا يُدخل الصنف
          المنتَج للمخزون. تكلفة الصنف المجمَّع تُشتق من طبقات تكلفة مكوّناته، وتنفيذها ناقصةً
          يفسد تقييم المخزون الذي تقوم عليه بقية التقارير.
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
            title="أمر تجميع جديد"
            description="كميات المكوّنات لكل وحدة واحدة من الصنف المنتَج"
          />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="الصنف المنتَج" required>
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
              <Field label="الكمية المطلوب تجميعها" required>
                <Input
                  numeric
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </Field>
              <Field label="المستودع" required>
                <Select
                  value={warehouseId}
                  placeholder="اختر مستودعاً…"
                  options={warehouses.map((warehouse) => ({
                    value: warehouse.id,
                    label: `${warehouse.code} — ${warehouse.nameAr}`,
                  }))}
                  onChange={(event) => setWarehouseId(event.target.value)}
                />
              </Field>
              <Field label="التاريخ" required>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(event) => setOrderDate(event.target.value)}
                />
              </Field>
            </div>

            {selfReferential ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                الصنف المنتَج مدرَج ضمن مكوّناته — أمر يستهلك ما ينتجه.
              </div>
            ) : null}

            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col" className="min-w-[18rem]">
                      المكوّن
                    </th>
                    <th scope="col">الكمية لكل وحدة</th>
                    <th scope="col" className="numeric">
                      الإجمالي المطلوب
                    </th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {components.map((component) => (
                    <tr key={component.key}>
                      <td>
                        <EntityPicker
                          entity="product"
                          value={component.productId}
                          valueLabel={component.productLabel}
                          placeholder="ابحث عن مكوّن…"
                          onSelect={(selection) =>
                            updateComponent(component.key, {
                              productId: selection.id,
                              productLabel: selection.label,
                            })
                          }
                        />
                      </td>
                      <td className="w-32">
                        <Input
                          numeric
                          inputMode="decimal"
                          value={component.quantityPerUnit}
                          onChange={(event) =>
                            updateComponent(component.key, { quantityPerUnit: event.target.value })
                          }
                        />
                      </td>
                      <td className="numeric text-muted-foreground">
                        {(
                          Number(component.quantityPerUnit || '0') * Number(quantity || '0')
                        ).toFixed(2)}
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={components.length === 1}
                          onClick={() =>
                            setComponents((previous) =>
                              previous.filter((other) => other.key !== component.key),
                            )
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">حذف المكوّن</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setComponents((previous) => [...previous, emptyComponent()])}
              >
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                إضافة مكوّن
              </Button>

              <Field label="ملاحظات" className="min-w-[16rem] flex-1">
                <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
              </Field>

              <Button
                className="ms-auto"
                loading={busy === 'create'}
                disabled={!canSubmit}
                onClick={() => void create()}
              >
                إنشاء الأمر
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="أوامر التجميع" description={`${orders.length} أمراً`} />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الرقم</th>
                <th scope="col">الصنف المنتَج</th>
                <th scope="col" className="numeric">
                  الكمية
                </th>
                <th scope="col" className="numeric">
                  المكوّنات
                </th>
                <th scope="col">المستودع</th>
                <th scope="col">التاريخ</th>
                <th scope="col">الحالة</th>
                {canEdit ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 8 : 7} className="py-16 text-center text-muted-foreground">
                    لا توجد أوامر تجميع
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.id}>
                    <td className="bidi-isolate font-mono text-xs text-primary">
                      {order.orderNumber}
                    </td>
                    <td className="max-w-[16rem]">
                      <p className="bidi-isolate font-mono text-[11px] text-muted-foreground">
                        {order.productSku}
                      </p>
                      <p className="truncate">{order.productNameAr}</p>
                    </td>
                    <td className="numeric font-medium">{order.quantity}</td>
                    <td className="numeric text-muted-foreground">{order.componentCount}</td>
                    <td className="text-xs">{order.warehouseNameAr}</td>
                    <td className="bidi-isolate font-mono text-xs">{order.orderDate}</td>
                    <td>
                      <Badge tone={ASSEMBLY_STATUS_TONES[order.status]}>
                        {ASSEMBLY_STATUS_LABELS_AR[order.status]}
                      </Badge>
                    </td>
                    {canEdit ? (
                      <td className="flex gap-2">
                        {order.status === 'DRAFT' ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              loading={busy === order.id}
                              onClick={() =>
                                void move(
                                  order.id,
                                  'COMPLETED',
                                  'أُغلق الأمر كمنفَّذ — لم تتحرك أي كمية في المخزون.',
                                )
                              }
                            >
                              إغلاق كمنفَّذ
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={busy === order.id}
                              onClick={() => void move(order.id, 'CANCELLED', 'أُلغي الأمر.')}
                            >
                              إلغاء
                            </Button>
                          </>
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
