import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  createAssemblyOrder,
  setAssemblyStatus,
} from '@/lib/application/services/commercial-setup-service';

/**
 * Assembly orders.
 *
 * `inventory.adjustment` authority even though completing one moves no stock: the order is an
 * instruction about warehouse contents, and whoever may not adjust stock should not be able to
 * issue instructions to build from it.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    productId: z.string().uuid(),
    quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
    warehouseId: z.string().uuid(),
    orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().trim().max(1024).optional(),
    components: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantityPerUnit: z.string().regex(/^\d+(\.\d{1,4})?$/),
        }),
      )
      .min(1)
      .max(100),
  }),
  z.object({
    action: z.literal('setStatus'),
    id: z.string().uuid(),
    status: z.enum(['COMPLETED', 'CANCELLED']),
  }),
]);

type AssemblyResult = { id: string; orderNumber: string } | { id: string };

export const POST = apiHandler<AssemblyResult>(
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

    const permitted = context.permissions.require(
      'inventory.adjustment',
      parsed.data.action === 'create' ? 'create' : 'update',
    );
    if (!permitted.ok) return permitted;

    const audit = {
      tenantId: context.tenantId,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
    };

    if (parsed.data.action === 'setStatus') {
      return setAssemblyStatus({
        tenantId: context.tenantId,
        audit,
        id: parsed.data.id,
        status: parsed.data.status,
      });
    }

    return createAssemblyOrder({
      tenantId: context.tenantId,
      userId: context.userId,
      audit,
      productId: parsed.data.productId,
      quantity: parsed.data.quantity,
      warehouseId: parsed.data.warehouseId,
      orderDate: parsed.data.orderDate,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      components: parsed.data.components,
    });
  },
  { rateLimit: 'mutation' },
);
