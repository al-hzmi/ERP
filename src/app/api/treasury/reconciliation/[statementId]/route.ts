import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { getReconciliation } from '@/lib/application/services/bank-reconciliation-service';

/**
 * One statement, its lines, its candidates and the difference.
 *
 * A single read rather than a call per line: the payments in scope are the same set for
 * every line, so scoring them once server-side is one query instead of one per row — and a
 * statement runs to hundreds of rows.
 */
export const GET = apiHandler(
  async (context, _request, params) => {
    const statementId = z.string().uuid().safeParse(params['statementId']);
    if (!statementId.success) {
      return err(
        DomainErrors.validation('معرّف الكشف غير صالح.', 'The statement id is not a valid uuid.', 'statementId'),
      );
    }

    return getReconciliation({ tenantId: context.tenantId, statementId: statementId.data });
  },
  { permission: { resource: 'treasury.reconciliation', action: 'read' } },
);
