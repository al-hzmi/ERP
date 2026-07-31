import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  TRADE_DOCUMENTS,
  createTradeDocument,
  setTradeDocumentStatus,
} from '@/lib/application/services/trade-document-service';

/**
 * One endpoint for quotations, sales orders, purchase orders and sales returns.
 *
 * The permission depends on the document type — a purchase order is a procurement concern and
 * a quotation is a sales one — so it is resolved after parsing rather than declared in the
 * handler options, which cannot see the body.
 */
const TYPES = ['QUOTATION', 'SALES_ORDER', 'PURCHASE_ORDER', 'SALES_RETURN'] as const;

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    type: z.enum(TYPES),
    counterpartyId: z.string().uuid(),
    branchId: z.string().uuid(),
    documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    notes: z.string().trim().max(1024).optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
          unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
          discountPercent: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
          taxRate: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  z.object({
    action: z.literal('setStatus'),
    type: z.enum(TYPES),
    id: z.string().uuid(),
    status: z.enum(['CONFIRMED', 'COMPLETED', 'CANCELLED']),
  }),
]);

type TradeResult = { id: string; documentNumber: string } | { id: string; status: string };

export const POST = apiHandler<TradeResult>(
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

    const definition = TRADE_DOCUMENTS[parsed.data.type];
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

    if (parsed.data.action === 'setStatus') {
      return setTradeDocumentStatus({
        tenantId: context.tenantId,
        audit,
        id: parsed.data.id,
        status: parsed.data.status,
      });
    }

    return createTradeDocument({
      tenantId: context.tenantId,
      userId: context.userId,
      audit,
      type: parsed.data.type,
      counterpartyId: parsed.data.counterpartyId,
      branchId: parsed.data.branchId,
      documentDate: parsed.data.documentDate,
      expectedDate: parsed.data.expectedDate ?? null,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      lines: parsed.data.lines,
    });
  },
  { rateLimit: 'mutation' },
);
