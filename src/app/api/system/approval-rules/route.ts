import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import {
  RULE_DOCUMENT_TYPES,
  createApprovalRule,
  setApprovalRuleActive,
} from '@/lib/application/services/approval-rules-service';

/**
 * Approval rules.
 *
 * `system.role:update` — a rule decides who must sign for what, which is authority over the
 * organisation's controls rather than over any one document. Whoever may reshape roles may
 * reshape what those roles are required to approve; nobody else.
 */
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    nameAr: z.string().trim().min(1).max(128),
    nameEn: z.string().trim().min(1).max(128),
    documentType: z.enum(RULE_DOCUMENT_TYPES),
    priority: z.number().int().min(1).max(1000).default(100),
    conditions: z
      .array(
        z.object({
          field: z.enum([
            'TOTAL_AMOUNT',
            'SUBTOTAL',
            'TAX_AMOUNT',
            'LINE_COUNT',
            'MAX_LINE_DISCOUNT_PERCENT',
            // Counterparty facts (migration 014) — the credit-hold integration.
            'OVERDUE_DAYS',
            'OVERDUE_AMOUNT',
            'CREDIT_EXPOSURE_PERCENT',
          ]),
          operator: z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ']),
          value: z.string().trim(),
        }),
      )
      .max(5)
      .default([]),
    approverRoleIds: z.array(z.string().uuid()).min(1).max(5),
    excludeInitiator: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('setActive'),
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
          'بيانات القاعدة غير مكتملة أو غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const permitted = context.permissions.require('system.role', 'update');
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
      return setApprovalRuleActive({
        tenantId: context.tenantId,
        audit,
        id: parsed.data.id,
        isActive: parsed.data.isActive,
      });
    }

    return createApprovalRule({
      tenantId: context.tenantId,
      audit,
      nameAr: parsed.data.nameAr,
      nameEn: parsed.data.nameEn,
      documentType: parsed.data.documentType,
      priority: parsed.data.priority,
      conditions: parsed.data.conditions,
      approverRoleIds: parsed.data.approverRoleIds,
      excludeInitiator: parsed.data.excludeInitiator,
    });
  },
  { rateLimit: 'mutation' },
);
