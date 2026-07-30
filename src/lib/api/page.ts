import { redirect } from 'next/navigation';
import { getRequestContext, type RequestContext } from '@/lib/infrastructure/auth/request-context';
import { runInTenantScope } from '@/lib/infrastructure/db/tenant-scope';

/**
 * What `apiHandler` is to a route, this is to a server component.
 *
 * A page in the authenticated segment does the same three things a route does
 * before it can load anything: read the request context, redirect if there is
 * none, and bind the tenant to the database session. The first two were already
 * written out in each page. The third was missing from all of them, and missing
 * invisibly: `users` and `documents` are under a fail-closed policy, so an
 * unscoped read does not fail, it returns nothing. A dashboard of zeroes and an
 * empty invoice register look like a quiet Tuesday rather than a wiring bug.
 *
 * Binding it here rather than in each page is the same argument the codebase makes
 * about authentication in `apiHandler`: a control every caller must remember to
 * invoke is a control that is one day not invoked.
 */
export async function withPageScope<T>(
  work: (context: RequestContext) => Promise<T>,
): Promise<T> {
  const result = await getRequestContext();

  if (!result.ok) {
    // `redirect` throws, so nothing below it runs. Typed as returning `never`,
    // which is why this needs no `return`.
    redirect('/login');
  }

  const context = result.value;

  return runInTenantScope(
    {
      tenantId: context.tenantId,
      userId: context.userId,
      correlationId: context.correlationId,
    },
    () => work(context),
  );
}
