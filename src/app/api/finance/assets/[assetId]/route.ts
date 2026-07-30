import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { getAssetSchedule } from '@/lib/application/services/depreciation-service';

/** One asset and its whole schedule, posted and unposted alike. */
export const GET = apiHandler(
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

    return getAssetSchedule({ tenantId: context.tenantId, assetId: assetId.data });
  },
  { permission: { resource: 'finance.fixedAsset', action: 'read' } },
);
