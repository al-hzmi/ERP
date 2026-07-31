'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { apiPost, type ApiError } from '@/lib/utils/api-client';
import type { PostingRuleRow } from '@/lib/application/services/posting-rules-service';

/**
 * Where each kind of transaction posts.
 *
 * **The missing required keys are the headline, above the table.** A tenant with no
 * `VAT_OUTPUT` mapping does not discover it at configuration time — it discovers it when the
 * first invoice with tax refuses to post, halfway through a month-end close. Putting the gaps
 * at the top is most of why this screen is worth having.
 *
 * **Changing a mapping does not move what already posted, and the screen says so.** A journal
 * line names an account; the mapping is only how that account was chosen at the time. Silence
 * on that point would invite someone to re-point `SALES_REVENUE` expecting last year to follow.
 */
export function PostingRulesTable({
  rules,
  accounts,
  canEdit,
}: {
  rules: readonly PostingRuleRow[];
  accounts: readonly { id: string; code: string; nameAr: string }[];
  canEdit: boolean;
}): JSX.Element {
  const router = useRouter();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const accountOptions = accounts.map((account) => ({
    value: account.id,
    label: `${account.code} — ${account.nameAr}`,
  }));

  const missing = rules.filter((rule) => rule.required && rule.accountId === null);

  async function assign(key: string, accountId: string): Promise<void> {
    if (accountId === '') return;

    setBusy(key);
    setError(null);
    setNotice(null);

    const response = await apiPost<{ key: string }>('/api/finance/posting-rules', {
      key,
      accountId,
    });
    setBusy(null);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setNotice('حُدِّثت القاعدة — تسري على العمليات الجديدة فقط.');
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

      {missing.length > 0 ? (
        <Card>
          <CardBody className="flex gap-3 border-s-4 border-s-destructive">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-destructive">
                {missing.length} قاعدة مطلوبة غير مربوطة بحساب
              </p>
              <p className="text-muted-foreground">
                العمليات التي تعتمد عليها سترفض الترحيل. لن يظهر الخطأ عند الإعداد، بل عند أول
                مستند يحتاجها — غالباً في منتصف إقفال الشهر.
              </p>
              <p className="text-muted-foreground">
                الناقص: {missing.map((rule) => rule.labelAr).join('، ')}
              </p>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="قواعد الترحيل الآلي"
          description="تحديد الحساب هنا يغيّر وجهة العمليات القادمة فقط — القيود المرحَّلة تبقى على حساباتها"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">القاعدة</th>
                <th scope="col">المفتاح</th>
                <th scope="col">الحساب</th>
                {canEdit ? <th scope="col">تغيير</th> : null}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.key}>
                  <td className="max-w-[18rem]">
                    <p className="truncate">{rule.labelAr}</p>
                    {rule.required ? (
                      <span className="text-[10px] text-muted-foreground">مطلوبة</span>
                    ) : null}
                  </td>
                  <td className="bidi-isolate font-mono text-[11px] text-muted-foreground">
                    {rule.key}
                  </td>
                  <td>
                    {rule.accountId === null ? (
                      <Badge tone={rule.required ? 'danger' : 'neutral'}>غير مربوطة</Badge>
                    ) : (
                      <span className="text-xs">
                        <span className="bidi-isolate font-mono text-primary">
                          {rule.accountCode}
                        </span>{' '}
                        — {rule.accountNameAr}
                      </span>
                    )}
                  </td>
                  {canEdit ? (
                    <td className="min-w-[16rem]">
                      <Select
                        placeholder="اختر حساباً…"
                        options={accountOptions}
                        defaultValue={rule.accountId ?? ''}
                        disabled={busy === rule.key}
                        onChange={(event) => void assign(rule.key, event.target.value)}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
