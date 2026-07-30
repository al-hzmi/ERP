import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { RESOURCES, ACTIONS, FIELD_LEVEL_PROTECTED } from '@/lib/infrastructure/auth/rbac';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'الأدوار والصلاحيات' };

/**
 * The permission matrix.
 *
 * Read-only, and this one is a security decision rather than a scoping one. Editing
 * permissions is the single most consequential write in the system — a mis-click grants
 * `finance.journal:post` to a salesperson — and doing it safely needs the things that make it
 * safe: segregation-of-duties validation against the toxic-combination matrix, an approval
 * step, and an audit entry per grant. A grid of checkboxes that wrote `role_permissions`
 * directly would have none of those and would look exactly as legitimate.
 *
 * What it does do is make the current state *legible*, which is what an auditor asks for and
 * what nothing else in the system answers: which role holds which permission, where a
 * wildcard is doing the work, and which grants are field-level.
 *
 * The matrix is rendered from `RESOURCES` and `ACTIONS` — the same constants authorisation
 * checks against — so a resource added to the catalogue appears here without anyone
 * remembering to add it.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: { role?: string };
}): Promise<JSX.Element> {
  const { roles, selected, denied } = await withPageScope(async (context) => {
    if (!context.permissions.can('platform.role', 'read')) {
      return { roles: [], selected: null, denied: true as const };
    }

    const loaded = await prisma.role.findMany({
      where: { tenantId: context.tenantId },
      select: {
        id: true,
        name: true,
        nameAr: true,
        description: true,
        isSystem: true,
        _count: { select: { userRoles: true } },
        rolePermissions: {
          select: {
            permission: { select: { resource: true, action: true, field: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const active = loaded.find((role) => role.id === searchParams.role) ?? loaded[0] ?? null;

    return { roles: loaded, selected: active, denied: false as const };
  });

  if (denied) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">الأدوار والصلاحيات</h1>
        </header>
        <Card>
          <div className="p-10 text-center text-sm text-muted-foreground">
            هذه الشاشة تتطلب صلاحية <span className="bidi-isolate font-mono">platform.role:read</span>.
          </div>
        </Card>
      </div>
    );
  }

  /** `resource:action` and the wildcard forms that satisfy it, as the checker resolves them. */
  const granted = new Set(
    (selected?.rolePermissions ?? []).map((entry) =>
      [entry.permission.resource, entry.permission.action, entry.permission.field ?? '']
        .join(':')
        .replace(/:$/, ''),
    ),
  );

  const holds = (resource: string, action: string): 'exact' | 'wildcard' | 'none' => {
    if (granted.has(`${resource}:${action}`)) return 'exact';
    if (
      granted.has(`${resource}:*`) ||
      granted.has(`*:${action}`) ||
      granted.has('*:*')
    ) {
      return 'wildcard';
    }
    return 'none';
  };

  const fieldGrants = [...granted].filter((entry) => entry.split(':').length === 3);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">الأدوار والصلاحيات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          عرض مصفوفة الصلاحيات — التعديل يتم عبر مسار يشمل فحص تعارض المهام والاعتماد والتدقيق
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader title="الأدوار" description={`${roles.length} دوراً`} />
          <CardBody className="space-y-1">
            {roles.map((role) => {
              const active = role.id === selected?.id;
              return (
                <a
                  key={role.id}
                  href={`/system/roles?role=${role.id}`}
                  className={
                    active
                      ? 'block rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary'
                      : 'block rounded-md px-3 py-2 text-sm hover:bg-accent'
                  }
                >
                  <span className="block">{role.nameAr}</span>
                  <span className="bidi-isolate block text-[11px] text-muted-foreground">
                    {role.name} · {role._count.userRoles} مستخدم
                  </span>
                </a>
              );
            })}
          </CardBody>
        </Card>

        <div className="space-y-6 lg:col-span-3">
          {selected === null ? (
            <Card>
              <div className="p-10 text-center text-sm text-muted-foreground">
                لا توجد أدوار معرَّفة.
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader
                  title={selected.nameAr}
                  description={selected.description ?? 'بلا وصف'}
                  action={
                    <div className="flex gap-1">
                      {selected.isSystem ? <Badge tone="info">دور نظام</Badge> : null}
                      <Badge tone="neutral">{granted.size} منحة</Badge>
                    </div>
                  }
                />
                {fieldGrants.length > 0 ? (
                  <CardBody className="border-t border-border">
                    <p className="text-xs text-muted-foreground">منح على مستوى الحقل</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {fieldGrants.map((entry) => (
                        <Badge key={entry} tone="warning">
                          <span className="bidi-isolate font-mono">{entry}</span>
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      الحقول المحمية ({Object.values(FIELD_LEVEL_PROTECTED).flat().join('، ')}) لا
                      تكفيها منحة على مستوى المورد — تتطلب منحة صريحة كهذه.
                    </p>
                  </CardBody>
                ) : null}
              </Card>

              <Card>
                <CardHeader
                  title="المصفوفة"
                  description="✓ منحة صريحة · ◆ عبر حرف بدل (wildcard)"
                />
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">المورد</th>
                        {ACTIONS.map((action) => (
                          <th key={action} scope="col" className="text-center">
                            <span className="bidi-isolate text-[10px]">{action}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {RESOURCES.map((resource) => (
                        <tr key={resource}>
                          <td className="bidi-isolate whitespace-nowrap font-mono text-[11px]">
                            {resource}
                          </td>
                          {ACTIONS.map((action) => {
                            const state = holds(resource, action);
                            return (
                              <td key={action} className="text-center">
                                {state === 'exact' ? (
                                  <span className="text-success" title="منحة صريحة">
                                    ✓
                                  </span>
                                ) : state === 'wildcard' ? (
                                  <span className="text-primary/70" title="عبر حرف بدل">
                                    ◆
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground/30">·</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
