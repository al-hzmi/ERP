import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { recordTransfer } from '@/lib/application/services/stock-operations-service';

/**
 * Stock transfers.
 *
 * Idempotent-keyed. A transfer submitted twice moves the stock twice, and the second move is
 * indistinguishable from a legitimate one when someone looks at the register a week later —
 * so the key matters more here than on a document that would at least show a duplicate number.
 */
const schema = z.object({
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(512).optional(),
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
          'بيانات التحويل غير مكتملة أو غير صحيحة.',
          first?.message ?? 'The transfer payload is invalid.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    return recordTransfer({
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
    permission: { resource: 'inventory.transfer', action: 'create' },
  },
);
