'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CalendarPlus, Lock, LockOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import type { FiscalYearRow } from '@/lib/application/services/fiscal-calendar-service';

const MONTHS_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

/**
 * The fiscal calendar: years, their periods, and the close button.
 *
 * **Closing a period is the one action on this screen that changes what the system will
 * accept.** `journal-service` refuses to post into a CLOSED period and a database trigger
 * refuses it independently, so this is a control rather than a label. The confirmation text
 * says as much — a button that stops the whole company posting should not be quieter than one
 * that renames a category.
 *
 * Periods close in order, and the button for an out-of-turn period is disabled rather than
 * hidden: the user needs to see that March exists and why it cannot be closed yet.
 */
export function FiscalCalendarBoard({
  years,
  canEdit,
}: {
  years: readonly FiscalYearRow[];
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [newYear, setNewYear] = useState(String(new Date().getUTCFullYear() + 1));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function send(payload: Record<string, unknown>, key: string, success: string): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ id: string }>('/api/finance/fiscal-calendar', payload);
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

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
          <CardHeader
            title="فتح سنة مالية"
            description="تُنشأ السنة مع اثنتي عشرة فترة شهرية دفعةً واحدة — سنة بلا فترات ترفض كل قيد يُرحَّل إليها"
          />
          <CardBody className="flex flex-wrap items-end gap-4">
            <Field label="السنة" required>
              <Input
                numeric
                inputMode="numeric"
                value={newYear}
                onChange={(event) => setNewYear(event.target.value)}
                className="w-32"
              />
            </Field>
            <Button
              loading={busy === 'create'}
              disabled={!/^\d{4}$/.test(newYear)}
              onClick={() =>
                void send(
                  { action: 'createYear', year: Number(newYear) },
                  'create',
                  `أُنشئت السنة المالية ${newYear} باثنتي عشرة فترة.`,
                )
              }
            >
              <CalendarPlus className="me-1.5 h-4 w-4" aria-hidden="true" />
              إنشاء
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {years.length === 0 ? (
        <Card>
          <CardBody className="py-16 text-center text-muted-foreground">
            لا توجد سنوات مالية بعد
          </CardBody>
        </Card>
      ) : null}

      {years.map((year) => {
        // The first still-open period. Everything after it is out of turn, and the service
        // refuses it — so the button is disabled rather than offered and then rejected.
        const firstOpen = year.periods.find((period) => period.status === 'OPEN');

        return (
          <Card key={year.id}>
            <CardHeader
              title={`السنة المالية ${year.year}`}
              description={`${year.startDate} إلى ${year.endDate}`}
              action={
                year.status === 'OPEN' ? (
                  <Badge tone="success">مفتوحة</Badge>
                ) : (
                  <Badge tone="neutral">مقفلة</Badge>
                )
              }
            />
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">الفترة</th>
                    <th scope="col">من</th>
                    <th scope="col">إلى</th>
                    <th scope="col" className="numeric">
                      القيود المرحَّلة
                    </th>
                    <th scope="col">الحالة</th>
                    {canEdit ? <th scope="col" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {year.periods.map((period) => {
                    const isNextToClose = firstOpen?.id === period.id;
                    const locked = period.status === 'LOCKED';

                    return (
                      <tr key={period.id}>
                        <td className="font-medium">
                          {MONTHS_AR[period.periodNumber - 1] ?? period.periodNumber}
                        </td>
                        <td className="bidi-isolate font-mono text-xs">{period.startDate}</td>
                        <td className="bidi-isolate font-mono text-xs">{period.endDate}</td>
                        <td className="numeric text-muted-foreground">{period.journalCount}</td>
                        <td>
                          {period.status === 'OPEN' ? (
                            <Badge tone="success">مفتوحة</Badge>
                          ) : period.status === 'CLOSED' ? (
                            <Badge tone="warning">مقفلة</Badge>
                          ) : (
                            <Badge tone="neutral">مقفلة نهائياً</Badge>
                          )}
                        </td>
                        {canEdit ? (
                          <td>
                            {locked ? null : period.status === 'OPEN' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!isNextToClose}
                                title={
                                  isNextToClose
                                    ? 'إقفال الفترة — يمنع ترحيل أي قيد جديد إليها'
                                    : 'يجب إقفال الفترات السابقة أولاً'
                                }
                                loading={busy === period.id}
                                onClick={() =>
                                  void send(
                                    {
                                      action: 'setPeriodStatus',
                                      periodId: period.id,
                                      status: 'CLOSED',
                                    },
                                    period.id,
                                    'أُقفلت الفترة — لن يُقبل أي قيد جديد بتاريخ داخلها.',
                                  )
                                }
                              >
                                <Lock className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
                                إقفال
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                loading={busy === period.id}
                                onClick={() =>
                                  void send(
                                    {
                                      action: 'setPeriodStatus',
                                      periodId: period.id,
                                      status: 'OPEN',
                                    },
                                    period.id,
                                    'أُعيد فتح الفترة — العملية مسجَّلة في سجل التدقيق.',
                                  )
                                }
                              >
                                <LockOpen className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
                                إعادة فتح
                              </Button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
