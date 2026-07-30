import Link from 'next/link';
import { Fingerprint } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'سجل التدقيق' };

const PAGE_SIZE = 40;

const ACTION_LABELS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  CREATE: { label: 'إنشاء', tone: 'success' },
  UPDATE: { label: 'تعديل', tone: 'info' },
  DELETE: { label: 'حذف', tone: 'danger' },
  POST: { label: 'ترحيل', tone: 'success' },
  VOID: { label: 'إلغاء', tone: 'danger' },
  APPROVE: { label: 'اعتماد', tone: 'success' },
  REJECT: { label: 'رفض', tone: 'warning' },
  LOGIN: { label: 'دخول', tone: 'neutral' },
  LOGOUT: { label: 'خروج', tone: 'neutral' },
  EXPORT: { label: 'تصدير', tone: 'warning' },
};

/**
 * The audit trail.
 *
 * Read-only, and that is a property of the table rather than of this screen:
 * `audit_logs_append_only` refuses every UPDATE and DELETE at the database, so there is no
 * edit path to withhold. A screen that offered one would be lying about what the system
 * permits.
 *
 * **`correlationId` is filterable and shown.** One use-case execution — posting an invoice —
 * writes several audit rows, and the correlation id is what ties them into a single story.
 * Without it the trail is a list of unrelated facts in timestamp order, which is exactly how
 * an audit trail becomes unusable at the moment it is needed.
 *
 * The table is partitioned monthly, so the date filter is not cosmetic: bounding the range
 * lets PostgreSQL prune partitions instead of scanning every month ever recorded.
 */
export default async function AuditTrailPage({
  searchParams,
}: {
  searchParams: {
    page?: string;
    action?: string;
    entity?: string;
    user?: string;
    from?: string;
    to?: string;
    correlation?: string;
  };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const action = searchParams.action;
  const entity = searchParams.entity?.trim();
  const userId = searchParams.user;
  const correlation = searchParams.correlation?.trim();

  const dateOf = (raw: string | undefined): string | undefined =>
    raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  const from = dateOf(searchParams.from);
  const to = dateOf(searchParams.to);

  const { entries, total, users, denied } = await withPageScope(async (context) => {
    if (!context.permissions.can('platform.audit', 'read')) {
      return { entries: [], total: 0, users: [], denied: true as const };
    }

    const where = {
      tenantId: context.tenantId,
      ...(action !== undefined && action !== 'ALL' ? { action: action as never } : {}),
      ...(entity !== undefined && entity !== '' ? { entityType: entity } : {}),
      ...(userId !== undefined && userId !== 'ALL' ? { userId } : {}),
      ...(correlation !== undefined && correlation !== '' ? { correlationId: correlation } : {}),
      ...(from !== undefined || to !== undefined
        ? {
            timestamp: {
              ...(from !== undefined ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
              // Inclusive of the end date: a filter to "31 March" that excluded that day's
              // entries would be read as a bug by everyone who used it.
              ...(to !== undefined ? { lt: new Date(`${to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [loaded, loadedTotal, loadedUsers] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          fieldName: true,
          timestamp: true,
          ipAddress: true,
          correlationId: true,
          metadata: true,
          user: { select: { username: true, fullNameAr: true } },
        },
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.auditLog.count({ where }),
      prisma.user.findMany({
        where: { tenantId: context.tenantId },
        select: { id: true, username: true, fullNameAr: true },
        orderBy: { username: 'asc' },
      }),
    ]);

    return { entries: loaded, total: loadedTotal, users: loadedUsers, denied: false as const };
  });

  if (denied) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">سجل التدقيق</h1>
        </header>
        <Card>
          <div className="p-10 text-center text-sm text-muted-foreground">
            الاطلاع على سجل التدقيق يتطلب صلاحية <span className="bidi-isolate font-mono">platform.audit:read</span>.
          </div>
        </Card>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const queryFor = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const merged = { action, entity, user: userId, from, to, correlation, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    return `/system/audit?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">سجل التدقيق</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{total.toLocaleString('en-US')}</span> قيد — السجل غير قابل
          للتعديل أو الحذف على مستوى قاعدة البيانات
        </p>
      </header>

      <Card>
        <form method="get" action="/system/audit" className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">الإجراء</span>
            <select
              name="action"
              defaultValue={action ?? 'ALL'}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="ALL">كل الإجراءات</option>
              {Object.entries(ACTION_LABELS).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">المستخدم</span>
            <select
              name="user"
              defaultValue={userId ?? 'ALL'}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="ALL">كل المستخدمين</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.fullNameAr} ({user.username})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">نوع الكيان</span>
            <input
              type="text"
              name="entity"
              defaultValue={entity ?? ''}
              placeholder="Journal، Document…"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">معرّف الارتباط</span>
            <input
              type="text"
              name="correlation"
              defaultValue={correlation ?? ''}
              placeholder="يربط كل قيود عملية واحدة"
              className="bidi-isolate h-9 rounded-md border border-input bg-background px-3 font-mono text-xs"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">من تاريخ</span>
            <input
              type="date"
              name="from"
              defaultValue={from ?? ''}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">إلى تاريخ</span>
            <input
              type="date"
              name="to"
              defaultValue={to ?? ''}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>

          <div className="flex items-end gap-2 sm:col-span-2">
            <button
              type="submit"
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              تصفية
            </button>
            <Link
              href="/system/audit"
              className="flex h-9 items-center rounded-md border border-border px-4 text-sm hover:bg-accent"
            >
              مسح
            </Link>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="القيود"
          description="الأحدث أولاً — تحديد نطاق التاريخ يقلّص الأقسام الممسوحة في جدول مقسَّم شهرياً"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">الوقت</th>
                <th scope="col">المستخدم</th>
                <th scope="col">الإجراء</th>
                <th scope="col">الكيان</th>
                <th scope="col">الحقل</th>
                <th scope="col">عنوان IP</th>
                <th scope="col">الارتباط</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    <Fingerprint className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
                    لا توجد قيود مطابقة للتصفية الحالية
                  </td>
                </tr>
              ) : (
                entries.map((entry) => {
                  const meta = ACTION_LABELS[entry.action] ?? {
                    label: entry.action,
                    tone: 'neutral' as const,
                  };

                  return (
                    <tr key={`${entry.id}-${entry.timestamp.toISOString()}`}>
                      <td className="whitespace-nowrap text-xs">
                        {formatDate(entry.timestamp, { style: 'medium' })}
                        <span className="bidi-isolate ms-1 text-[11px] text-muted-foreground">
                          {entry.timestamp.toISOString().slice(11, 19)}
                        </span>
                      </td>
                      <td className="text-xs">
                        {entry.user === null ? (
                          <span className="text-muted-foreground">النظام</span>
                        ) : (
                          <>
                            <span>{entry.user.fullNameAr}</span>
                            <span className="bidi-isolate ms-1 text-[11px] text-muted-foreground">
                              {entry.user.username}
                            </span>
                          </>
                        )}
                      </td>
                      <td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td className="text-xs">
                        <span className="bidi-isolate">{entry.entityType}</span>
                        <span className="bidi-isolate block truncate font-mono text-[10px] text-muted-foreground">
                          {entry.entityId.slice(0, 8)}
                        </span>
                      </td>
                      <td className="bidi-isolate text-xs text-muted-foreground">
                        {entry.fieldName ?? '—'}
                      </td>
                      <td className="bidi-isolate font-mono text-[11px] text-muted-foreground">
                        {entry.ipAddress ?? '—'}
                      </td>
                      <td>
                        {entry.correlationId === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Link
                            href={queryFor({ correlation: entry.correlationId, page: '1' })}
                            className="bidi-isolate font-mono text-[11px] text-primary hover:underline"
                            title="عرض كل قيود هذه العملية"
                          >
                            {entry.correlationId.slice(0, 8)}
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
            <p className="text-muted-foreground">
              صفحة <span className="numeric">{page}</span> من <span className="numeric">{totalPages}</span>
            </p>
            <div className="flex gap-2">
              <Link
                href={queryFor({ page: String(Math.max(1, page - 1)) })}
                className={
                  page === 1
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                السابق
              </Link>
              <Link
                href={queryFor({ page: String(Math.min(totalPages, page + 1)) })}
                className={
                  page === totalPages
                    ? 'pointer-events-none rounded-md border border-border px-3 py-1.5 text-xs opacity-40'
                    : 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent'
                }
              >
                التالي
              </Link>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
