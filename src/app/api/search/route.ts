import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { search, type SearchEntity } from '@/lib/application/services/search-service';

const ENTITIES: readonly SearchEntity[] = [
  'product',
  'counterparty',
  'account',
  'document',
  'employee',
];

/**
 * Federated search.
 *
 * Entities the caller has no permission to read are not queried at all, rather
 * than queried and filtered — the cheapest way to enforce a rule is not to do
 * the work in the first place.
 */
export const GET = apiHandler(
  async (context, request) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';
    const requested = url.searchParams.get('entities')?.split(',') ?? [];

    const permitted = ENTITIES.filter((entity) => {
      if (requested.length > 0 && !requested.includes(entity)) return false;
      switch (entity) {
        case 'product':
          return context.permissions.can('inventory.product', 'read');
        case 'counterparty':
          return (
            context.permissions.can('sales.customer', 'read') ||
            context.permissions.can('procurement.supplier', 'read')
          );
        case 'account':
          return context.permissions.can('finance.account', 'read');
        case 'document':
          return (
            context.permissions.can('sales.invoice', 'read') ||
            context.permissions.can('procurement.invoice', 'read')
          );
        case 'employee':
          return context.permissions.can('hr.employee', 'read');
        default:
          return false;
      }
    });

    const results = await search({
      tenantId: context.tenantId,
      query,
      entities: permitted,
      limitPerEntity: 8,
    });

    return ok({ query, results });
  },
  { rateLimit: 'search' },
);
