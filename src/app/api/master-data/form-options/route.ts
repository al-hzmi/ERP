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
    const [branches, warehouses, currencies, accounts, taxCodes, tenant] = await Promise.all([
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
      // Bounded like the rest — a tenant has a handful of VAT treatments, not thousands — and
      // needed before the line grid can render its rate column at all.
      tx.taxCode.findMany({
        where: { tenantId: context.tenantId, isActive: true },
        select: {
          id: true,
          code: true,
          nameAr: true,
          rate: true,
          treatment: true,
          isDefault: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      tx.tenant.findUniqueOrThrow({
        where: { id: context.tenantId },
        select: { functionalCurrency: true },
      }),
    ]);

    return { branches, warehouses, currencies, accounts, taxCodes, tenant };
  });

  return ok({
    branches: options.branches,
    warehouses: options.warehouses,
    currencies: options.currencies,
    accounts: options.accounts,
    taxCodes: options.taxCodes.map((taxCode) => ({
      id: taxCode.id,
      code: taxCode.code,
      nameAr: taxCode.nameAr,
      // A string, not a Decimal: the client does exact arithmetic on it and a float would
      // reintroduce the rounding this system exists to avoid.
      rate: taxCode.rate.toFixed(2),
      treatment: taxCode.treatment,
      isDefault: taxCode.isDefault,
    })),
    functionalCurrency: options.tenant.functionalCurrency,
  });
});