import { apiHandler } from '@/lib/api/handler';
import { ok } from '@/lib/domain/shared/result';
import { withTenantRead } from '@/lib/infrastructure/db/prisma';

/**
 * The small, bounded lists a data-entry form needs to render its pickers.
 *
 * One request rather than five, because these are all needed before the form is
 * usable and five parallel round trips to populate one screen is four more than the
 * screen deserves. They are bounded by nature — a company has branches and
 * warehouses in the tens — which is what makes returning them whole reasonable.
 *
 * Deliberately *not* here: products and counterparties. Those run to thousands, and
 * a picker over them is a search box against `/api/search`, not a `<select>` with
 * five thousand options in it.
 */
export const GET = apiHandler(async (context) => {
  // One transaction for five reads: the client extension would otherwise open one
  // per query, each with its own `set_config` round trip.
  const options = await withTenantRead(async (tx) => {
    const [branches, warehouses, currencies, accounts, tenant] = await Promise.all([
      tx.branch.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: 'asc' },
      }),
      tx.warehouse.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { id: true, code: true, nameAr: true, branchId: true },
        orderBy: { code: 'asc' },
      }),
      tx.currency.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: { code: true, nameAr: true, minorUnits: true },
        orderBy: { code: 'asc' },
      }),
      // Only postable accounts: a journal line against a parent account is what
      // makes a chart of accounts stop reconciling to itself.
      tx.account.findMany({
        where: { tenantId: context.tenantId, isActive: true, isPostable: true },
        select: { id: true, code: true, nameAr: true, type: true },
        orderBy: { code: 'asc' },
      }),
      tx.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
    ]);

    return { branches, warehouses, currencies, accounts, tenant };
  });

  return ok({
    branches: options.branches,
    warehouses: options.warehouses,
    currencies: options.currencies,
    accounts: options.accounts,
    functionalCurrency: options.tenant.functionalCurrency,
  });
});