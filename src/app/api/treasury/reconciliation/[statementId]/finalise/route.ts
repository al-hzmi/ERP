import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  finaliseStatement,
  reopenStatement,
} from '@/lib/application/services/bank-reconciliation-service';

/**
 * Signing a statement off, and taking it back.
 *
 * Sign-off is refused unless the difference is exactly zero. That refusal is the control:
 * a button that let someone assert agreement that does not exist would make `isReconciled`
 * mean "somebody clicked", where it is supposed to mean "the difference was zero and this
 * person says so".
 *
 * Reopening is allowed, and logged at `warn`. A reconciliation that could never be
 * corrected would push people into correcting the *ledger* instead, which is the more
 * expensive mistake.
 */

const bodySchema = z.object({ action: z.enum(['finalise', 'reopen']) });

export const POST = apiHandler(
  async (context, request, params) => {
    const statementId = z.string().uuid().safeParse(params['statementId']);
    if (!statementId.success) {
      return err(
        DomainErrors.validation(
          'معرّف الكشف غير صالح.',
          'The statement id is not a valid uuid.',
          'statementId',
        ),
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return err(
        DomainErrors.validation(
          'الإجراء المطلوب غير معروف.',
          'The action must be either finalise or reopen.',
          'action',
        ),
      );
    }

    const input = {
      tenantId: context.tenantId,
      statementId: statementId.data,
      userId: context.userId,
    };

    return parsed.data.action === 'finalise' ? finaliseStatement(input) : reopenStatement(input);
  },
  {
    rateLimit: 'mutation',
    // Signing off is an assertion about the ledger, so it needs more than the update right
    // that matching does.
    permission: { resource: 'treasury.reconciliation', action: 'approve' },
  },
);
