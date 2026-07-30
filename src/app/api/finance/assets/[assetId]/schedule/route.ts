import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { generateSchedule } from '@/lib/application/services/depreciation-service';

/**
 * Generates the missing periods of an asset's schedule.
 *
 * Safe to call twice: `(assetId, periodDate)` is unique, so a second call inserts nothing and
 * reports zero created. That is why it needs no idempotency key — the operation is idempotent
 * in the database rather than by bookkeeping around it.
 */
export const POST = apiHandler(
  async (context, _request, params) => {
    const assetId = z.string().uuid().safeParse(params['assetId']);
    if (!assetId.success) {
      return err(
        DomainErrors.validation(
          'معرّف الأصل غير صالح.',
          'The asset id is not a valid uuid.',
          'assetId',
        ),
      );
    }

    return generateSchedule({
      tenantId: context.tenantId,
      assetId: assetId.data,
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
    permission: { resource: 'finance.fixedAsset', action: 'create' },
  },
);
