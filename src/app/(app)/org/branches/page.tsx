import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'الفروع والمستودعات' };

/**
 * Branches and their warehouses.
 *
 * Nested rather than two flat lists, because the relationship is the information: a warehouse
 * belongs to exactly one branch, and a branch's default warehouse is what every document
 * without an explicit one falls back to. Two separate tables would leave the reader to join
 * them by eye.
 *
 * The default warehouse is marked, because a branch without one silently fails every document
 * that relies on the fallback — and that failure surfaces at posting time, far from its cause.
 */
export default async function BranchesPage(): Promise<JSX.Element> {
  const branches = await withPageScope(async (context) =>
    prisma.branch.findMany({
      where: { tenantId: context.tenantId },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        city: true,
        phone: true,
        isActive: true,
        defaultWarehouseId: true,
        warehouses: {
          select: {
            id: true,
            code: true,
            nameAr: true,
            location: true,
            isQuarantine: true,
            isActive: true,
            _count: { select: { stockLevels: true } },
          },
          orderBy: { code: 'asc' },
        },
      },
      orderBy: { code: 'asc' },
    }),
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">الفروع والمستودعات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{branches.length}</span> فرعاً و
          <span className="numeric">
            {branches.reduce((sum, branch) => sum + branch.warehouses.length, 0)}
          </span>{' '}
          مستودعاً
        </p>
      </header>

      {branches.length === 0 ? (
        <Card>
          <div className="p-10 text-center text-sm text-muted-foreground">لا توجد فروع معرَّفة.</div>
        </Card>
      ) : (
        branches.map((branch) => (
          <Card key={branch.id}>
            <CardHeader
              title={`${branch.code} · ${branch.nameAr}`}
              description={[branch.city, branch.phone].filter(Boolean).join(' — ') || branch.nameEn}
              action={
                branch.isActive ? (
                  <Badge tone="success">نشِط</Badge>
                ) : (
                  <Badge tone="neutral">موقوف</Badge>
                )
              }
            />
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">رمز المستودع</th>
                    <th scope="col">الاسم</th>
                    <th scope="col">الموقع</th>
                    <th scope="col" className="numeric">سجلات الرصيد</th>
                    <th scope="col">الخصائص</th>
                  </tr>
                </thead>
                <tbody>
                  {branch.warehouses.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-muted-foreground">
                        لا توجد مستودعات لهذا الفرع
                      </td>
                    </tr>
                  ) : (
                    branch.warehouses.map((warehouse) => (
                      <tr key={warehouse.id}>
                        <td className="bidi-isolate font-mono text-xs text-primary">
                          {warehouse.code}
                        </td>
                        <td>{warehouse.nameAr}</td>
                        <td className="text-xs text-muted-foreground">
                          {warehouse.location ?? '—'}
                        </td>
                        <td className="numeric text-muted-foreground">
                          {warehouse._count.stockLevels}
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {warehouse.id === branch.defaultWarehouseId ? (
                              <Badge tone="info">افتراضي للفرع</Badge>
                            ) : null}
                            {warehouse.isQuarantine ? <Badge tone="warning">حجر</Badge> : null}
                            {!warehouse.isActive ? <Badge tone="neutral">موقوف</Badge> : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
