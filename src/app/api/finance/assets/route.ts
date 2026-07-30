import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { listAssets } from '@/lib/application/services/depreciation-service';

/** The asset register, with each asset's schedule progress. */
export const GET = apiHandler(
  async (context, request) => {
    const includeDisposed =
      new URL(request.url).searchParams.get('includeDisposed') === 'true';

    const items = await listAssets({ tenantId: context.tenantId, includeDisposed });

    return ok({ items });
  },
  { permission: { resource: 'finance.fixedAsset', action: 'read' } },
);
