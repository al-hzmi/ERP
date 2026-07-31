import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import {
  submitZatcaInvoice,
  type SubmitResult,
} from '@/lib/application/services/zatca-submission-service';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';

/**
 * Sends one e-invoice to ZATCA.
 *
 * `finance.invoice:update` rather than `system.role`: submitting is an operational act on a
 * document that already exists, performed by whoever handles invoices. Installing the
 * credentials that make submission possible is the privileged act, and that is the other route.
 */
const schema = z.object({ zatcaInvoiceId: z.string().uuid() });

export const POST = apiHandler<SubmitResult>(
  async (context, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(DomainErrors.validation('صيغة الطلب غير صحيحة.', 'Malformed request body.'));
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return err(DomainErrors.validation('معرِّف الفاتورة غير صحيح.', 'Invalid invoice id.'));
    }

    const permitted = context.permissions.require('finance.invoice', 'update');
    if (!permitted.ok) return permitted;

    return submitZatcaInvoice({
      tenantId: context.tenantId,
      audit: {
        tenantId: context.tenantId,
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        sessionId: context.sessionId,
        correlationId: context.correlationId,
      },
      zatcaInvoiceId: parsed.data.zatcaInvoiceId,
    });
  },
  { rateLimit: 'mutation' },
);
