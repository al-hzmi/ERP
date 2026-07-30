import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { listStatements } from '@/lib/application/services/bank-reconciliation-service';

/** The statements available to reconcile, newest period first. */
export const GET = apiHandler(
  async (context, request) => {
    const accountId = new URL(request.url).searchParams.get('accountId');

    const statements = await listStatements({
      tenantId: context.tenantId,
      ...(accountId !== null && accountId !== '' ? { accountId } : {}),
    });

    return ok({ items: statements });
  },
  { permission: { resource: 'treasury.reconciliation', action: 'read' } },
);
