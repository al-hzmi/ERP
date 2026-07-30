import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  MASTER_DATA,
  createMasterData,
  setMasterDataActive,
} from '@/lib/application/services/master-data-service';

/**
 * One endpoint for the four reference tables.
 *
 * The permission checked depends on the kind — cost centres are a finance concern and
 * categories are an inventory one — so it is resolved after parsing rather than declared in
 * the handler options, which cannot see the body.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    kind: z.enum(['category', 'brand', 'unit', 'costCenter']),
    code: z.string().trim().max(32).default(''),
    nameAr: z.string().trim().min(1).max(128),
    nameEn: z.string().trim().min(1).max(128),
    baseFactor: z.string().trim().optional(),
  }),
  z.object({
    action: z.literal('setActive'),
    kind: z.enum(['category', 'brand', 'unit', 'costCenter']),
    id: z.string().uuid(),
    isActive: z.boolean(),
  }),
]);

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
          'البيانات غير مكتملة أو غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const definition = MASTER_DATA[parsed.data.kind];
    const permitted = context.permissions.require(
      definition.resource,
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

    if (parsed.data.action === 'setActive') {
      return setMasterDataActive({
        tenantId: context.tenantId,
        audit,
        kind: parsed.data.kind,
        id: parsed.data.id,
        isActive: parsed.data.isActive,
      });
    }

    return createMasterData({
      tenantId: context.tenantId,
      audit,
      kind: parsed.data.kind,
      code: parsed.data.code,
      nameAr: parsed.data.nameAr,
      nameEn: parsed.data.nameEn,
      ...(parsed.data.baseFactor !== undefined ? { baseFactor: parsed.data.baseFactor } : {}),
    });
  },
  { rateLimit: 'mutation' },
);
