import Link from 'next/link';
import { ListTree } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatMoney } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'شجرة الحسابات' };

const TYPE_LABELS: Record<string, string> = {
  ASSET: 'أصول',
  LIABILITY: 'خصوم',
  EQUITY: 'حقوق ملكية',
  REVENUE: 'إيرادات',
  EXPENSE: 'مصروفات',
};

const TYPE_TONES: Record<string, 'success' | 'warning' | 'info' | 'neutral' | 'danger'> = {
  ASSET: 'success',
  LIABILITY: 'warning',
  EQUITY: 'info',
  REVENUE: 'success',
  EXPENSE: 'danger',
};

/**
 * The chart of accounts.
 *
 * Rendered as a tree because the hierarchy carries meaning that a flat list destroys: a
 * posting account's parent is what a report groups it under, and `isPostable` is the line
 * between a heading and a place a journal line may land. A flat table sorted by code *looks*
 * like a tree and silently loses the distinction the moment a code scheme has a gap in it.
 *
 * **Depth comes from `path`, not from walking `parentId` in the browser.** Every account
 * carries a materialised path, indexed, so one ordered query returns the whole chart already
 * in tree order — where a recursive fetch would be one query per level and would still need
 * sorting afterwards.
 *
 * **`balance` is the cached current balance, and it is labelled as such.** It is maintained by
 * `erp_apply_journal_to_balances` on every posting, so it is authoritative for "right now" and
 * says nothing about any period. Anyone asking a period question is sent to the general ledger,
 * which computes from the lines.
 */
export default async function ChartOfAccountsPage({
  searchParams,
}: {
  searchParams: { type?: string; q?: string; postable?: string };
}): Promise<JSX.Element> {
  const type = searchParams.type;
  const query = searchParams.q?.trim();
  const postableOnly = searchParams.postable === 'true';

  const { accounts, currency, counts } = await withPageScope(async (context) => {
    const [loaded, tenant] = await Promise.all([
      prisma.account.findMany({
        where: {
          tenantId: context.tenantId,
          ...(type !== undefined && type !== 'ALL' ? { type: type as never } : {}),
          ...(postableOnly ? { isPostable: true } : {}),
          ...(query !== undefined && query !== ''
            ? {
                OR: [
                  { code: { contains: query, mode: 'insensitive' as const } },
                  { nameAr: { contains: query, mode: 'insensitive' as const } },
                  { nameEn: { contains: query, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          type: true,
          nature: true,
          level: true,
          path: true,
          isPostable: true,
          isControl: true,
          isContra: true,
          isActive: true,
          balance: true,
          currency: true,
          _count: { select: { journalLines: true } },
        },
        // Path order is tree order. Sorting by `code` gives the same answer only while every
        // code is the same length, which stops being true the first time someone adds a
        // three-digit account under a two-digit parent.
        orderBy: { path: 'asc' },
      }),
      prisma.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
    ]);

    const byType = new Map<string, number>();
    for (const account of loaded) {
      byType.set(account.type, (byType.get(account.type) ?? 0) + 1);
    }

    return { accounts: loaded, currency: tenant.functionalCurrency, counts: byType };
  });

  const TYPE_FILTERS = [
    { value: 'ALL', label: 'الكل' },
    ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })),
  ];

  const postableCount = accounts.filter((account) => account.isPostable).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">شجرة الحسابات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{accounts.length}</span> حساباً، منها{' '}
          <span className="numeric">{postableCount}</span> قابلاً للترحيل
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Object.entries(TYPE_LABELS).map(([value, label]) => (
          <Card key={value}>
            <CardBody>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="numeric mt-1 text-xl font-semibold">{counts.get(value) ?? 0}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="الشجرة"
          description="الحساب غير القابل للترحيل عنوان تجميعي — لا يقبل سطر قيد"
          action={
            <nav className="flex flex-wrap gap-1" aria-label="تصفية حسب النوع">
              {TYPE_FILTERS.map((filter) => {
                const active = (type ?? 'ALL') === filter.value;
                const params = new URLSearchParams();
                if (filter.value !== 'ALL') params.set('type', filter.value);
                if (query !== undefined && query !== '') params.set('q', query);
                if (postableOnly) params.set('postable', 'true');

                return (
                  <Link
                    key={filter.value}
                    href={`/finance/accounts?${params.toString()}`}
                    className={
                      active
                        ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
                        : 'rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent'
                    }
                  >
                    {filter.label}
                  </Link>
                );
              })}
            </nav>
          }
        />

        <form method="get" action="/finance/accounts" className="flex flex-wrap items-center gap-3 px-5 pb-4">
          {type !== undefined && type !== 'ALL' ? (
            <input type="hidden" name="type" value={type} />
          ) : null}
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder="ابحث برقم الحساب أو اسمه…"
            aria-label="بحث في شجرة الحسابات"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              name="postable"
              value="true"
              defaultChecked={postableOnly}
              className="h-4 w-4 rounded border-input"
            />
            القابلة للترحيل فقط
          </label>
          <button
            type="submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            تصفية
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">رقم الحساب</th>
                <th scope="col">الاسم</th>
                <th scope="col">النوع</th>
                <th scope="col">الطبيعة</th>
                <th scope="col" className="numeric">السطور</th>
                <th scope="col" className="numeric">الرصيد الحالي</th>
                <th scope="col">الخصائص</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    <ListTree className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
                    لا توجد حسابات مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      {/* Indented by level, so the hierarchy is visible without a second
                          column of dots. A filtered view breaks the visual nesting — the
                          parents are gone — and the indent still tells you the depth. */}
                      <span
                        className="bidi-isolate font-mono text-xs font-medium"
                        style={{ paddingInlineStart: `${Math.min(account.level, 6) * 0.9}rem` }}
                      >
                        {account.isPostable ? (
                          <Link
                            href={`/finance/general-ledger?account=${account.id}`}
                            className="text-primary hover:underline"
                            title="عرض دفتر الأستاذ لهذا الحساب"
                          >
                            {account.code}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{account.code}</span>
                        )}
                      </span>
                    </td>
                    <td className="max-w-[20rem]">
                      <span className={account.isPostable ? '' : 'font-medium'}>
                        {account.nameAr}
                      </span>
                      <span className="bidi-isolate block truncate text-[11px] text-muted-foreground">
                        {account.nameEn}
                      </span>
                    </td>
                    <td>
                      <Badge tone={TYPE_TONES[account.type] ?? 'neutral'}>
                        {TYPE_LABELS[account.type] ?? account.type}
                      </Badge>
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {account.nature === 'DEBIT' ? 'مدين' : 'دائن'}
                    </td>
                    <td className="numeric text-muted-foreground">{account._count.journalLines}</td>
                    <td className="numeric">
                      {account.isPostable ? (
                        formatMoney(account.balance.toFixed(4), {
                          currency: account.currency ?? currency,
                          showCurrency: false,
                        })
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {!account.isPostable ? <Badge tone="neutral">تجميعي</Badge> : null}
                        {account.isControl ? <Badge tone="info">حساب مراقبة</Badge> : null}
                        {account.isContra ? <Badge tone="warning">مقابل</Badge> : null}
                        {!account.isActive ? <Badge tone="neutral">موقوف</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        عمود «الرصيد الحالي» هو الرصيد المخزَّن على الحساب، يحدّثه مُشغِّل قاعدة البيانات عند كل
        ترحيل — فهو صحيح للحظة الراهنة ولا يعبّر عن أي فترة. لسؤال عن فترة، افتح دفتر الأستاذ.
      </p>
    </div>
  );
}
