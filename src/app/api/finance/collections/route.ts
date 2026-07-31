import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { upsertCreditProfile } from '@/lib/application/services/collections-service';

/**
 * Credit profile maintenance.
 *
 * `sales.customer:update` — the terms are an attribute of the customer, and whoever may edit a
 * customer may set how long the company waits before chasing them. Blocking is the same
 * authority: it is a commercial decision, not a system-administration one.
 */
const schema = z.object({
  counterpartyId: z.string().uuid(),
  graceDays: z.number().int().min(0).max(365),
  holdAfterDays: z.number().int().min(0).max(3650),
  isBlocked: z.boolean().default(false),
  blockReason: z.string().trim().max(512).nullish(),
  notes: z.string().trim().max(1024).nullish(),
});

export const POST = apiHandler<{ id: string }>(
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
          'بيانات السياسة الائتمانية غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const permitted = context.permissions.require('sales.customer', 'update');
    if (!permitted.ok) return permitted;

    return upsertCreditProfile({
      tenantId: context.tenantId,
      audit: {
        tenantId: context.tenantId,
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        sessionId: context.sessionId,
        correlationId: context.correlationId,
      },
      counterpartyId: parsed.data.counterpartyId,
      graceDays: parsed.data.graceDays,
      holdAfterDays: parsed.data.holdAfterDays,
      isBlocked: parsed.data.isBlocked,
      blockReason: parsed.data.blockReason ?? null,
      notes: parsed.data.notes ?? null,
    });
  },
  { rateLimit: 'mutation' },
);
