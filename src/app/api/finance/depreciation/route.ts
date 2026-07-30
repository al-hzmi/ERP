import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { previewRun, runDepreciation } from '@/lib/application/services/depreciation-service';

/**
 * The depreciation run.
 *
 * `GET` previews, `POST` posts, and both resolve the due set through the same function — so
 * the confirmation the user sees is what the run will do rather than a second calculation
 * that can drift from it.
 *
 * `POST` is idempotent-keyed. A run is the most expensive thing in this module to do twice
 * (a duplicate depreciation journal has to be reversed, and the register's accumulated
 * column is wrong until it is), and the offline queue may replay it. The `SERIALIZABLE`
 * transaction already stops two concurrent runs from both posting; the key stops a *retry*
 * of a request whose response was lost from posting a second entry.
 */

function parseAsOf(raw: string | null) {
  // Defaults to today rather than requiring the parameter: "run what is due" is the common
  // case, and a date is only supplied when catching up or closing a past month.
  if (raw === null || raw === '') return DateOnly.create(new Date());
  return DateOnly.create(raw);
}

export const GET = apiHandler(
  async (context, request) => {
    const asOf = parseAsOf(new URL(request.url).searchParams.get('asOf'));
    if (!asOf.ok) return asOf;

    return previewRun({ tenantId: context.tenantId, asOf: asOf.value });
  },
  { permission: { resource: 'finance.fixedAsset', action: 'read' } },
);

const bodySchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const POST = apiHandler(
  async (context, request) => {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // An empty body is a run for today, which is the ordinary case from a button.
      body = {};
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return err(
        DomainErrors.validation(
          'تاريخ التشغيل يجب أن يكون بالصيغة YYYY-MM-DD.',
          'asOf must be a date in YYYY-MM-DD form.',
          'asOf',
        ),
      );
    }

    const asOf = parseAsOf(parsed.data.asOf ?? null);
    if (!asOf.ok) return asOf;

    return runDepreciation({
      tenantId: context.tenantId,
      asOf: asOf.value,
      userId: context.userId,
      audit: {
        tenantId: context.tenantId,
        userId: context.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        sessionId: context.sessionId,
        correlationId: context.correlationId,
      },
    });
  },
  {
    rateLimit: 'mutation',
    idempotent: true,
    // Posting to the ledger, so `post` rather than the `create` that generating a schedule
    // needs. An accountant may prepare the register; charging the period is the controller's.
    permission: { resource: 'finance.fixedAsset', action: 'post' },
  },
);
