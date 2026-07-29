import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { prisma } from '@/lib/infrastructure/db/prisma';

/** The signed-in user, their branches and their effective permissions. */
export const GET = apiHandler(async (context) => {
  const [user, branches] = await Promise.all([
    prisma.user.findUnique({
      where: { id: context.userId },
      select: {
        id: true,
        username: true,
        fullNameAr: true,
        fullNameEn: true,
        email: true,
        locale: true,
        timezone: true,
        calendarPref: true,
        numeralSystem: true,
        defaultBranchId: true,
        isSuperAdmin: true,
        lastLoginAt: true,
        tenant: { select: { nameAr: true, nameEn: true, functionalCurrency: true } },
      },
    }),
    prisma.branch.findMany({
      where: { tenantId: context.tenantId, isActive: true },
      select: { id: true, code: true, nameAr: true, nameEn: true },
      orderBy: { code: 'asc' },
    }),
  ]);

  return ok({ user, branches, permissions: context.permissions.toArray() });
});
