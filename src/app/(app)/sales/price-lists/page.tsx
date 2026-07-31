import { PriceListBoard } from '@/components/commercial/price-list-board';
import { withPageScope } from '@/lib/api/page';
import {
  getPriceList,
  listPriceLists,
} from '@/lib/application/services/commercial-setup-service';
import { prisma } from '@/lib/infrastructure/db/prisma';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'قوائم الأسعار' };

/**
 * Price lists, with one expanded.
 *
 * The chosen list is in the URL rather than in component state: a list of prices is a thing
 * somebody sends to a colleague, and a screen whose address does not say which list is open
 * cannot be shared.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { list?: string };
}): Promise<JSX.Element> {
  const { lists, selected, currency, canEdit } = await withPageScope(async (context) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: context.tenantId },
      select: { functionalCurrency: true },
    });

    const all = await listPriceLists({ tenantId: context.tenantId, includeInactive: true });

    return {
      lists: all,
      selected:
        searchParams.list === undefined
          ? null
          : await getPriceList({ tenantId: context.tenantId, id: searchParams.list }),
      currency: tenant.functionalCurrency,
      canEdit: context.permissions.can('sales.customer', 'create'),
    };
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">قوائم الأسعار</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          كتالوجات أسعار بفترات صلاحية وشرائح كمية
        </p>
      </header>

      <PriceListBoard lists={lists} selected={selected} currency={currency} canEdit={canEdit} />
    </div>
  );
}
