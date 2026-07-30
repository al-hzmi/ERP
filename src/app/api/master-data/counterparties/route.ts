import { z } from 'zod';
import { apiHandler, paginated, parsePagination } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err, ok } from '@/lib/domain/shared/result';
import { listCounterparties } from '@/lib/application/services/counterparty-service';

/**
 * Customers and suppliers as JSON.
 *
 * `kind` is required rather than defaulted. A default would silently return customers to a
 * caller asking for suppliers, and the two lists overlap — `BOTH` appears in each — so the
 * mistake would look like a working response.
 *
 * The permission checked follows the kind: reading the supplier list is
 * `procurement.supplier:read`, not `sales.customer:read`. One table does not mean one
 * privilege — a salesperson has no business reading supplier terms.
 */
export const GET = apiHandler(
  async (context, request) => {
    const url = new URL(request.url);
    const { page, pageSize } = parsePagination(request);

    const kind = z.enum(['CUSTOMER', 'SUPPLIER']).safeParse(url.searchParams.get('kind'));
    if (!kind.success) {
      return err(
        DomainErrors.validation(
          'يجب تحديد النوع: عميل أو مورد.',
          'kind must be CUSTOMER or SUPPLIER.',
          'kind',
        ),
      );
    }

    const resource = kind.data === 'CUSTOMER' ? 'sales.customer' : 'procurement.supplier';
    const permitted = context.permissions.require(resource, 'read');
    if (!permitted.ok) return permitted;

    const query = url.searchParams.get('q')?.trim();
    const status = url.searchParams.get('status');

    const { rows, total } = await listCounterparties({
      tenantId: context.tenantId,
      kind: kind.data,
      ...(query !== undefined && query !== '' ? { query } : {}),
      status: status === 'INACTIVE' || status === 'ALL' ? status : 'ACTIVE',
      page,
      pageSize,
    });

    // `creditLimit` is field-protected. Stripped after the query rather than conditionally
    // selected, because the service returns one shape — and a shape that varies by caller is
    // how a client ends up reading `undefined` as zero.
    const canSeeCredit = context.permissions.can('sales.customer', 'read', 'creditLimit');
    const items = canSeeCredit
      ? rows
      : rows.map(({ creditLimit: _creditLimit, ...rest }) => rest);

    return ok(paginated(items, total, { page, pageSize }));
  },
  // No handler-level `permission`: the resource depends on `kind`, which is only known after
  // the query string is parsed. Declaring a single one here would either deny an accountant
  // reading suppliers or admit a salesperson to them — the check inside is the correct
  // authority, and it runs before any data is read.
  {},
);
