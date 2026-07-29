import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { QueryProvider } from '@/components/providers/query-provider';
import { getRequestContext } from '@/lib/infrastructure/auth/request-context';
import { prisma } from '@/lib/infrastructure/db/prisma';

/**
 * The authenticated area.
 *
 * Authentication is checked here, on the server, before any page in this
 * segment renders. Guarding in a client component would ship the page to the
 * browser first and redirect afterwards — which briefly hands unauthenticated
 * markup to whoever asked for it.
 */
export default async function AppLayout({ children }: { children: ReactNode }): Promise<JSX.Element> {
  const context = await getRequestContext();

  if (!context.ok) {
    redirect('/login');
  }

  const user = await prisma.user.findUnique({
    where: { id: context.value.userId },
    select: {
      fullNameAr: true,
      fullNameEn: true,
      tenant: { select: { nameAr: true } },
    },
  });

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
