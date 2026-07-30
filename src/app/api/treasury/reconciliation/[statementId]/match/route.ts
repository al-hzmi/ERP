import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import {
  autoMatchStatement,
  matchLine,
  unmatchLine,
} from '@/lib/application/services/bank-reconciliation-service';

/**
 * Matching, unmatching, and the automatic pass.
 *
 * One endpoint with an `action` rather than three, because all three are the same
 * operation on the same resource — the set of matches on a statement — and splitting them
 * across routes would mean three copies of the statement lookup and the sign-off check.
 *
 * The eligibility rules live in the service, not here. A control enforced at one entry
 * point is a control with a way around it, and every one of these rules is about not
 * reconciling something twice.
 */

/**
 * One response shape, tagged by the action that produced it.
 *
 * The three operations naturally return different things — a match has a score, the
 * automatic pass has counts — and a client that has to guess which shape it received from
 * the request it sent is a client that will guess wrong once. Tagging costs one field.
 */
type MatchResponse =
  | { action: 'match'; lineId: string; score: number }
  | { action: 'unmatch'; lineId: string }
  | { action: 'auto'; matched: number; ambiguous: number; unmatched: number };

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('match'),
    lineId: z.string().uuid(),
    paymentId: z.string().uuid(),
  }),
  z.object({ action: z.literal('unmatch'), lineId: z.string().uuid() }),
  z.object({ action: z.literal('auto') }),
]);

export const POST = apiHandler<MatchResponse>(
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
          'The action must be one of match, unmatch or auto.',
          'action',
        ),
      );
    }

    const common = {
      tenantId: context.tenantId,
      statementId: statementId.data,
      userId: context.userId,
    };

    if (parsed.data.action === 'match') {
      const result = await matchLine({
        ...common,
        lineId: parsed.data.lineId,
        paymentId: parsed.data.paymentId,
      });
      return result.ok ? ok({ action: 'match' as const, ...result.value }) : result;
    }

    if (parsed.data.action === 'unmatch') {
      const result = await unmatchLine({ ...common, lineId: parsed.data.lineId });
      return result.ok ? ok({ action: 'unmatch' as const, ...result.value }) : result;
    }

    const result = await autoMatchStatement(common);
    return result.ok ? ok({ action: 'auto' as const, ...result.value }) : result;
  },
  {
    rateLimit: 'mutation',
    permission: { resource: 'treasury.reconciliation', action: 'update' },
  },
);
