import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { decideApproval } from '@/lib/application/services/approval-service';

/**
 * Records one approval decision.
 *
 * The eligibility rules — the right role, not the initiator, not already acted —
 * live in the service rather than here, because this route is not the only way the
 * decision could ever be taken and a rule enforced at one entry point is a rule with
 * a way around it.
 */

const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().trim().max(512).optional(),
});

export const POST = apiHandler(
  async (context, request, params) => {
    const id = z.string().uuid().safeParse(params['id']);
    if (!id.success) {
      return err(
        DomainErrors.validation('معرّف الطلب غير صالح.', 'The request id is not a valid uuid.', 'id'),
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) {
      return err(
        DomainErrors.validation(
          'القرار يجب أن يكون اعتماداً أو رفضاً.',
          'The decision must be either APPROVED or REJECTED.',
          'decision',
        ),
      );
    }

    return decideApproval({
      tenantId: context.tenantId,
      userId: context.userId,
      requestId: id.data,
      decision: parsed.data.decision,
      ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
    });
  },
  { rateLimit: 'mutation' },
);
