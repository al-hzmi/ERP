import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { saveTaxCode, setDefaultTaxCode } from '@/lib/application/services/tax-code-service';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';

/**
 * Tax codes.
 *
 * `finance.account:update` — a tax code decides how a supply is declared to ZATCA, which is the
 * same class of authority as reshaping the chart of accounts and firmly not something a sales
 * clerk does mid-invoice.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    id: z.string().uuid().optional(),
    code: z.string().trim().min(2).max(32),
    nameAr: z.string().trim().min(1).max(128),
    nameEn: z.string().trim().min(1).max(128),
    treatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE']),
    rate: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/),
    exemptionReasonAr: z.string().trim().max(256).optional().nullable(),
    exemptionReasonCode: z.string().trim().max(16).optional().nullable(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(100),
  }),
  z.object({
    action: z.literal('setDefault'),
    id: z.string().uuid(),
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
          'بيانات رمز الضريبة غير مكتملة أو غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const permitted = context.permissions.require('finance.account', 'update');
    if (!permitted.ok) return permitted;

    const audit = {
      tenantId: context.tenantId,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
    };

    if (parsed.data.action === 'setDefault') {
      return setDefaultTaxCode({ tenantId: context.tenantId, audit, id: parsed.data.id });
    }

    return saveTaxCode({ tenantId: context.tenantId, audit, ...parsed.data });
  },
  { rateLimit: 'mutation' },
);
