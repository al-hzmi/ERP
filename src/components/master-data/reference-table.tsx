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
import type {
  MasterDataDefinition,
  MasterDataKind,
  MasterDataRow,
} from '@/lib/application/services/master-data-service';

/**
 * The four reference tables — categories, brands, units, cost centres — as one component.
 *
 * They are the same shape, so this is one screen parameterised four ways rather than four
 * screens with the same bug in three of them.
 *
 * **There is no delete, and the usage column is why.** Every one of these is referenced by
 * rows that outlive it, and the foreign keys are `ON DELETE RESTRICT` — a delete button would
 * fail on precisely the records that matter and succeed only on ones nobody would miss.
 * Showing how many records point at each one makes deactivating the obvious operation instead
 * of a consolation prize.
 *
 * `router.refresh()` after a write rather than local state: the list is server-rendered inside
 * the tenant scope, and re-fetching it there keeps one source of truth for what exists.
 */
export function ReferenceTable({
  kind,
  definition,
  rows,
  canEdit,
  includeInactive,
  basePath,
}: {
  kind: MasterDataKind;
  definition: MasterDataDefinition;
  rows: readonly MasterDataRow[];
  canEdit: boolean;
  includeInactive: boolean;
  basePath: string;
}): JSX.Element {
  const router = useRouter();

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [baseFactor, setBaseFactor] = useState('1');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canSubmit =
    nameAr.trim() !== '' && nameEn.trim() !== '' && (!definition.hasCode || code.trim() !== '');

  async function create(): Promise<void> {
    setBusy('create');
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/master-data/records', {
      action: 'create',
      kind,
      code: code.trim(),
      nameAr: nameAr.trim(),
      nameEn: nameEn.trim(),
      ...(kind === 'unit' ? { baseFactor: baseFactor.trim() } : {}),
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setCode('');
    setNameAr('');
    setNameEn('');
    setBaseFactor('1');
    setNotice('أُضيف السجل.');
    router.refresh();
  }

  async function toggle(id: string, isActive: boolean): Promise<void> {
    setBusy(id);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/master-data/records', {
      action: 'setActive',
      kind,
      id,
      isActive,
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setNotice(isActive ? 'أُعيد تفعيل السجل.' : 'أُوقف السجل — لا يظهر في القوائم الجديدة.');
    router.refresh();
  }

  const columns = 4 + (definition.detailLabelAr !== null ? 1 : 0) + (canEdit ? 1 : 0);

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
          <CardHeader title="إضافة سجل" description={definition.descriptionAr} />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {definition.hasCode ? (
              <Field label={definition.codeLabelAr} required>
                <Input value={code} onChange={(event) => setCode(event.target.value)} />
              </Field>
            ) : null}
            <Field label="الاسم بالعربية" required>
              <Input value={nameAr} onChange={(event) => setNameAr(event.target.value)} />
            </Field>
            <Field label="الاسم بالإنجليزية" required>
              <Input
                value={nameEn}
                dir="ltr"
                onChange={(event) => setNameEn(event.target.value)}
              />
            </Field>
            {kind === 'unit' ? (
              <Field
                label="معامل التحويل"
                hint="كم وحدة أساسية تعادلها هذه الوحدة — 1 للوحدة الأساسية نفسها"
              >
                <Input
                  numeric
                  inputMode="decimal"
                  value={baseFactor}
                  onChange={(event) => setBaseFactor(event.target.value)}
                />
              </Field>
            ) : null}
            <div className="flex items-end">
              <Button loading={busy === 'create'} disabled={!canSubmit} onClick={() => void create()}>
                <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
                إضافة
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="السجلات"
          description={`${rows.length} سجلاً — لا يوجد حذف: السجل المرتبط بحركات لا يُحذف، بل يُوقَف`}
          action={
            <a
              href={`${basePath}${includeInactive ? '' : '?inactive=true'}`}
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
                <th scope="col">{definition.codeLabelAr}</th>
                <th scope="col">الاسم</th>
                {definition.detailLabelAr !== null ? (
                  <th scope="col">{definition.detailLabelAr}</th>
                ) : null}
                <th scope="col" className="numeric">
                  {definition.usageLabelAr}
                </th>
                <th scope="col">الحالة</th>
                {canEdit ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns} className="py-16 text-center text-muted-foreground">
                    لا توجد سجلات
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className={row.isActive ? undefined : 'opacity-60'}>
                    <td className="bidi-isolate font-mono text-xs text-primary">{row.code}</td>
                    <td className="max-w-[20rem]">
                      <p className="truncate">{row.nameAr}</p>
                      <p className="bidi-isolate truncate text-[11px] text-muted-foreground">
                        {row.nameEn}
                      </p>
                    </td>
                    {definition.detailLabelAr !== null ? (
                      <td className="text-xs text-muted-foreground">{row.detail ?? '—'}</td>
                    ) : null}
                    <td className="numeric text-muted-foreground">{row.usageCount}</td>
                    <td>
                      {row.isActive ? (
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
                          loading={busy === row.id}
                          onClick={() => void toggle(row.id, !row.isActive)}
                        >
                          {row.isActive ? 'إيقاف' : 'تفعيل'}
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
