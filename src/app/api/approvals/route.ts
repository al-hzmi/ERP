import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { listPendingApprovals } from '@/lib/application/services/approval-service';

/**
 * The caller's approval inbox.
 *
 * No pagination, deliberately: an inbox that needs paging is an inbox nobody is
 * clearing, and the fix for that is a threshold change rather than a page control.
 * If it ever grows past a screenful the honest response is to say how many are
 * waiting, which the client can do from the array it already has.
 */
export const GET = apiHandler(async (context) => {
  const pending = await listPendingApprovals({
    tenantId: context.tenantId,
    userId: context.userId,
  });

  return ok({ items: pending, total: pending.length });
});
