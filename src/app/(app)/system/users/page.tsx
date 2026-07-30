import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';
import { formatDate } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'المستخدمون' };

/**
 * The user register.
 *
 * Read-only, deliberately, and the reason is worth stating rather than apologising for:
 * creating a user means setting a password, and every credential path in this system — hashing
 * at cost 12, the lockout counters, the refresh-token family — lives in `auth/`. A form that
 * wrote `users` directly would bypass all of it, and a form that called it properly is a
 * feature with its own security review, not a table with an "add" button.
 *
 * What the screen *does* answer is the question an auditor actually asks: who has access, with
 * which roles, and is anyone locked out or dormant. `lockedUntil` and `failedAttempts` are
 * shown because a user silently locked out at 3pm on a Thursday is a support call nobody can
 * diagnose otherwise.
 *
 * `passwordHash` is never selected. Not masked — not read.
 */
export default async function UsersPage(): Promise<JSX.Element> {
  const { users, denied } = await withPageScope(async (context) => {
    if (!context.permissions.can('platform.user', 'read')) {
      return { users: [], denied: true as const };
    }

    const loaded = await prisma.user.findMany({
      where: { tenantId: context.tenantId },
      select: {
        id: true,
        username: true,
        email: true,
        fullNameAr: true,
        fullNameEn: true,
        isActive: true,
        isSuperAdmin: true,
        lastLoginAt: true,
        failedAttempts: true,
        lockedUntil: true,
        passwordChangedAt: true,
        defaultBranch: { select: { code: true, nameAr: true } },
        userRoles: { select: { role: { select: { name: true, nameAr: true } } } },
      },
      orderBy: { username: 'asc' },
    });

    return { users: loaded, denied: false as const };
  });

  if (denied) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">المستخدمون</h1>
        </header>
        <Card>
          <div className="p-10 text-center text-sm text-muted-foreground">
            هذه الشاشة تتطلب صلاحية <span className="bidi-isolate font-mono">platform.user:read</span>.
          </div>
        </Card>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">المستخدمون</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{users.length}</span> مستخدماً — إنشاء المستخدمين وتغيير
          كلمات المرور يتمان عبر مسار المصادقة، لا من هذه الشاشة
        </p>
      </header>

      <Card>
        <CardHeader
          title="السجل"
          description="حالة القفل ومحاولات الدخول الفاشلة ظاهرة لأن المستخدم المقفَل بصمت لا يمكن تشخيصه"
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">اسم المستخدم</th>
                <th scope="col">الاسم</th>
                <th scope="col">البريد</th>
                <th scope="col">الأدوار</th>
                <th scope="col">الفرع الافتراضي</th>
                <th scope="col">آخر دخول</th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-muted-foreground">
                    لا يوجد مستخدمون
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const locked = user.lockedUntil !== null && user.lockedUntil > now;

                  return (
                    <tr key={user.id}>
                      <td className="bidi-isolate font-mono text-xs font-medium text-primary">
                        {user.username}
                      </td>
                      <td className="max-w-[14rem]">
                        <p className="truncate">{user.fullNameAr}</p>
                        <p className="bidi-isolate truncate text-[11px] text-muted-foreground">
                          {user.fullNameEn}
                        </p>
                      </td>
                      <td className="bidi-isolate max-w-[14rem] truncate text-xs text-muted-foreground">
                        {user.email}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {user.userRoles.length === 0 ? (
                            <span className="text-xs text-muted-foreground">بلا دور</span>
                          ) : (
                            user.userRoles.map((assignment) => (
                              <Badge key={assignment.role.name} tone="info">
                                {assignment.role.nameAr}
                              </Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="text-xs text-muted-foreground">
                        {user.defaultBranch === null ? '—' : user.defaultBranch.nameAr}
                      </td>
                      <td className="whitespace-nowrap text-xs text-muted-foreground">
                        {user.lastLoginAt === null
                          ? 'لم يدخل بعد'
                          : formatDate(user.lastLoginAt, { style: 'medium' })}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {user.isSuperAdmin ? <Badge tone="danger">مدير عام</Badge> : null}
                          {user.isActive ? (
                            <Badge tone="success">نشِط</Badge>
                          ) : (
                            <Badge tone="neutral">موقوف</Badge>
                          )}
                          {locked ? <Badge tone="warning">مقفَل</Badge> : null}
                          {user.failedAttempts > 0 && !locked ? (
                            <Badge tone="warning">
                              {user.failedAttempts} محاولة فاشلة
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
