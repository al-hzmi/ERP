import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  createFiscalYear,
  setPeriodStatus,
} from '@/lib/application/services/fiscal-calendar-service';

/**
 * The fiscal calendar, and closing periods in it.
 *
 * Both actions are `finance.period` rather than `finance.journal`: closing a period stops
 * everyone else posting, which is a different authority from being allowed to post.
 */
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('createYear'), year: z.number().int() }),
  z.object({
    action: z.literal('setPeriodStatus'),
    periodId: z.string().uuid(),
    status: z.enum(['OPEN', 'CLOSED']),
  }),
]);

type CalendarResult = { id: string; periods: number } | { id: string };

export const POST = apiHandler<CalendarResult>(
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

    const permitted = context.permissions.require('finance.period', 'update');
    if (!permitted.ok) return permitted;

    const audit = {
      tenantId: context.tenantId,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
    };

    if (parsed.data.action === 'createYear') {
      return createFiscalYear({ tenantId: context.tenantId, audit, year: parsed.data.year });
    }

    return setPeriodStatus({
      tenantId: context.tenantId,
      audit,
      periodId: parsed.data.periodId,
      status: parsed.data.status,
    });
  },
  { rateLimit: 'mutation' },
);
