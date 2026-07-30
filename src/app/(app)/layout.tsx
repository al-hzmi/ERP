import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { QueryProvider } from '@/components/providers/query-provider';
import { withPageScope } from '@/lib/api/page';
import { prisma } from '@/lib/infrastructure/db/prisma';

/**
 * The authenticated area.
 *
 * Authentication is checked here, on the server, before any page in this
 * segment renders. Guarding in a client component would ship the page to the
 * browser first and redirect afterwards — which briefly hands unauthenticated
 * markup to whoever asked for it.
 *
 * `withPageScope` does the redirect and binds the tenant to the database session.
 * `users` is under a fail-closed policy, so without the binding the lookup below
 * returns `null` and the shell renders with no name and no company — an empty
 * header rather than an error.
 */
export default async function AppLayout({ children }: { children: ReactNode }): Promise<JSX.Element> {
  const user = await withPageScope(async (context) =>
    prisma.user.findUnique({
      where: { id: context.userId },
      select: {
        fullNameAr: true,
        fullNameEn: true,
        tenant: { select: { nameAr: true } },
      },
    }),
  );

  return (
    <QueryProvider>
      <AppShell
        user={
          user === null
            ? null
            : {
                fullNameAr: user.fullNameAr,
                fullNameEn: user.fullNameEn,
                tenantNameAr: user.tenant.nameAr,
              }
        }
      >
        {children}
      </AppShell>
    </QueryProvider>
  );
}
