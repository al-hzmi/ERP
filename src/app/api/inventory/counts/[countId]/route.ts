import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  cancelStockCount,
  finaliseStockCount,
  getStockCount,
  recordCountedQuantities,
} from '@/lib/application/services/stock-count-service';

/**
 * One count sheet: read it, enter quantities, finalise or cancel it.
 *
 * `countedQuantity` accepts `null` explicitly, which is how a mis-keyed line is *unset* rather
 * than zeroed. Zero is a real finding — an empty shelf — so there has to be a way to say "I
 * did not count this after all" that does not mean "there was nothing there".
 */
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('record'),
    entries: z
      .array(
        z.object({
          lineId: z.string().uuid(),
          countedQuantity: z.string().nullable(),
        }),
      )
      .min(1)
      .max(500),
  }),
  z.object({ action: z.literal('finalise') }),
  z.object({ action: z.literal('cancel') }),
]);

/**
 * What a POST to this route can return.
 *
 * Named rather than inferred: the three actions produce three different shapes, and without a
 * union the handler's generic would silently take the first branch's type and reject the rest.
 */
type CountActionResult =
  | { updated: number }
  | { countId: string }
  | {
      countId: string;
      countNumber: string;
      adjustmentsPosted: number;
      uncountedLines: number;
      netValue: string;
    };

function parseId(raw: unknown) {
  return z.string().uuid().safeParse(raw);
}

export const GET = apiHandler(
  async (context, _request, params) => {
    const countId = parseId(params['countId']);
    if (!countId.success) {
      return err(
        DomainErrors.validation('معرّف الجرد غير صالح.', 'Invalid count id.', 'countId'),
      );
    }

    return getStockCount({ tenantId: context.tenantId, countId: countId.data });
  },
  { permission: { resource: 'inventory.adjustment', action: 'read' } },
);

export const POST = apiHandler<CountActionResult>(
  async (context, request, params) => {
    const countId = parseId(params['countId']);
    if (!countId.success) {
      return err(
        DomainErrors.validation('معرّف الجرد غير صالح.', 'Invalid count id.', 'countId'),
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return err(
        DomainErrors.validation(
          'الإجراء المطلوب غير معروف.',
          'action must be record, finalise or cancel.',
          'action',
        ),
      );
    }

    const audit = {
      tenantId: context.tenantId,
      userId: context.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
    };

    if (parsed.data.action === 'record') {
      return recordCountedQuantities({
        tenantId: context.tenantId,
        userId: context.userId,
        countId: countId.data,
        entries: parsed.data.entries,
      });
    }

    if (parsed.data.action === 'cancel') {
      return cancelStockCount({
        tenantId: context.tenantId,
        userId: context.userId,
        audit,
        countId: countId.data,
      });
    }

    return finaliseStockCount({
      tenantId: context.tenantId,
      userId: context.userId,
      audit,
      countId: countId.data,
    });
  },
  {
    rateLimit: 'mutation',
    // Finalising writes stock off against the ledger, so `create` on adjustments is the right
    // bar — the same one the manual adjustment screen clears.
    permission: { resource: 'inventory.adjustment', action: 'create' },
  },
);
