import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { recordAdjustment } from '@/lib/application/services/stock-operations-service';

/**
 * Stock adjustments.
 *
 * `quantity` is a signed string, not a magnitude plus a direction flag. Two fields that must
 * agree are two fields that can disagree, and the one that would win is whichever the service
 * happened to read — so the sign carries the direction and there is nothing to reconcile.
 */
const schema = z.object({
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(1).max(512),
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
});

export const POST = apiHandler(
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
          'بيانات التسوية غير مكتملة أو غير صحيحة.',
          first?.message ?? 'The adjustment payload is invalid.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    return recordAdjustment({
      tenantId: context.tenantId,
      userId: context.userId,
      audit: {
        tenantId: context.tenantId,
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        sessionId: context.sessionId,
        correlationId: context.correlationId,
      },
      ...parsed.data,
    });
  },
  {
    rateLimit: 'mutation',
    idempotent: true,
    // Adjusting stock writes to the ledger, so it is its own permission rather than an
    // extension of the transfer right: moving stock between your own warehouses and writing
    // it off are different levels of trust.
    permission: { resource: 'inventory.adjustment', action: 'create' },
  },
);
