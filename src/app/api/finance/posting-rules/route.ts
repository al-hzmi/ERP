import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { setPostingRule } from '@/lib/application/services/posting-rules-service';

/**
 * Re-points a posting key at an account.
 *
 * `finance.account:update` — this decides where every future invoice, adjustment and payroll
 * run lands in the ledger, which is authority over the chart rather than over one document.
 */
const schema = z.object({
  key: z.string().trim().min(1).max(64),
  accountId: z.string().uuid(),
});

export const POST = apiHandler<{ key: string }>(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(
        DomainErrors.validation(
          'البيانات غير مكتملة أو غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const permitted = context.permissions.require('finance.account', 'update');
    if (!permitted.ok) return permitted;

    return setPostingRule({
      tenantId: context.tenantId,
      audit: {
        tenantId: context.tenantId,
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        sessionId: context.sessionId,
        correlationId: context.correlationId,
      },
      key: parsed.data.key,
      accountId: parsed.data.accountId,
    });
  },
  { rateLimit: 'mutation' },
);
