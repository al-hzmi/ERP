import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { saveZatcaConfig } from '@/lib/application/services/zatca-config-service';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';

/**
 * ZATCA device credentials.
 *
 * `system.role:update` — installing a CSID gives this deployment the ability to sign invoices
 * in the taxpayer's name. That is authority over the organisation's legal identity, not over
 * any one document, so it sits with whoever may reshape roles and with nobody else.
 *
 * The blank-means-keep rule is enforced in the service, not here: a schema that rejected empty
 * secrets would make it impossible to edit the VAT number without re-pasting the private key.
 */
const schema = z.object({
  environment: z.enum(['SANDBOX', 'SIMULATION', 'PRODUCTION']),
  sellerVatNumber: z.string().trim().min(15).max(15),
  sellerNameAr: z.string().trim().min(1).max(256),
  commercialRegNo: z.string().trim().max(32).optional().nullable(),
  streetName: z.string().trim().max(128).optional().nullable(),
  buildingNumber: z.string().trim().max(8).optional().nullable(),
  citySubdivision: z.string().trim().max(128).optional().nullable(),
  cityName: z.string().trim().max(128).optional().nullable(),
  postalZone: z.string().trim().max(8).optional().nullable(),
  // Generous ceilings: a PEM certificate chain is a few kilobytes, and a limit that clips one
  // produces a certificate that parses right up until it does not.
  csidCertificate: z.string().max(20_000).optional().nullable(),
  csidSecret: z.string().max(4_000).optional().nullable(),
  privateKey: z.string().max(20_000).optional().nullable(),
  isActive: z.boolean().default(false),
});

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
          'بيانات إعدادات الفوترة الإلكترونية غير مكتملة أو غير صحيحة.',
          first?.message ?? 'Invalid payload.',
          typeof first?.path[0] === 'string' ? first.path[0] : undefined,
        ),
      );
    }

    const permitted = context.permissions.require('system.role', 'update');
    if (!permitted.ok) return permitted;

    return saveZatcaConfig({
      tenantId: context.tenantId,
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
  { rateLimit: 'mutation' },
);
