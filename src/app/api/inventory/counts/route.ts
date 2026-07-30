import { z } from 'zod';
import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import { listStockCounts, openStockCount } from '@/lib/application/services/stock-count-service';

/**
 * Stock count sheets.
 *
 * Opening one is idempotent-keyed *and* guarded by a one-open-sheet-per-warehouse rule in the
 * service. Both are needed: the key stops a retry of a lost response from opening a second
 * sheet, and the rule stops two different people opening one an hour apart — which the key
 * cannot see.
 */
const openSchema = z.object({
  warehouseId: z.string().uuid(),
  countDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(512).optional(),
});

export const GET = apiHandler(
  async (context, request) => {
    const { page, pageSize } = parsePagination(request);
    const { rows, total } = await listStockCounts({ tenantId: context.tenantId, page, pageSize });
    return ok(paginated(rows, total, { page, pageSize }));
  },
  { permission: { resource: 'inventory.adjustment', action: 'read' } },
);

export const POST = apiHandler(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = openSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return err(
        DomainErrors.validation(
          'بيانات فتح الجرد غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    return openStockCount({
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
    permission: { resource: 'inventory.adjustment', action: 'create' },
  },
);
