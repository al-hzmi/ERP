import { z } from 'zod';
import { apiHandler } from '@/lib/api/handler';
import { DomainErrors } from '@/lib/domain/shared/errors';
import { err } from '@/lib/domain/shared/result';
import { postSalesInvoice } from '@/lib/application/use-cases/post-sales-invoice';

/**
 * Posts a sales invoice.
 *
 * A dedicated route rather than a PATCH on the invoice, because posting is not
 * an edit: it is a distinct, irreversible business act with its own permission,
 * its own segregation-of-duties rule and its own audit entry.
 *
 * This used to be written against the raw Next.js signature, because
 * `apiHandler` had no way to receive the dynamic `[id]`. The cost of that
 * workaround was a route that re-implemented authentication, rate limiting and
 * error shaping by hand — and, in doing so, skipped the route-level permission
 * gate every other endpoint gets. Nothing was exposed, because the use case
 * checks the same permission itself; but the next route copied from this one
 * would have inherited the omission without inheriting the second line of
 * defence. `apiHandler` now takes route params, so the exception is gone.
 */

/**
 * The id is validated before it reaches the use case.
 *
 * A path segment is user input. Passing an arbitrary string to a lookup means
 * the difference between "not found" and "malformed request" is decided by
 * whatever the database does with it — and on a `uuid` column, that is an error
 * rather than an empty result.
 */
const paramsSchema = z.object({
  id: z.string().uuid(),
});

export const POST = apiHandler(
  async (context, _request, params) => {
    const parsed = paramsSchema.safeParse(params);

    if (!parsed.success) {
      return err(
        DomainErrors.validation(
          'معرّف الفاتورة غير صالح.',
          'The invoice identifier is not a valid UUID.',
          'id',
        ),
      );
    }

    return postSalesInvoice(context, { documentId: parsed.data.id });
  },
  {
    rateLimit: 'mutation',
    permission: { resource: 'sales.invoice', action: 'post' },
  },
);
