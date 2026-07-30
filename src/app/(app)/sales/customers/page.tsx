import { CounterpartyRegister } from '@/components/master-data/counterparty-register';
import { withPageScope } from '@/lib/api/page';
import { listCounterparties } from '@/lib/application/services/counterparty-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'العملاء' };

const PAGE_SIZE = 25;

/**
 * العملاء.
 *
 * Thin by design: `counterparty-service` holds the query and `CounterpartyRegister` holds the
 * table, because customers and suppliers are one table read two ways. Duplicating either would
 * be how two implementations of "outstanding balance" come to disagree.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: { page?: string; q?: string; status?: string };
}): Promise<JSX.Element> {
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const query = searchParams.q?.trim();
  const status = (searchParams.status ?? 'ACTIVE') as 'ACTIVE' | 'INACTIVE' | 'ALL';

  const { rows, total, canSeeCredit } = await withPageScope(async (context) => {
    const listed = await listCounterparties({
      tenantId: context.tenantId,
      kind: 'CUSTOMER',
      ...(query !== undefined ? { query } : {}),
      status,
      page,
      pageSize: PAGE_SIZE,
    });

    return {
      ...listed,
      // Field-level: an ordinary read grant does not cover it, which is the whole point.
      canSeeCredit: context.permissions.can('sales.customer', 'read', 'creditLimit'),
    };
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">العملاء</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="numeric">{total.toLocaleString('en-US')}</span> — من يشتري من المنشأة — الرصيد الموجب مديونية عليه
        </p>
      </header>

      <CounterpartyRegister
        kind="CUSTOMER"
        basePath="/sales/customers"
        rows={rows}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        query={query}
        status={status}
        canSeeCredit={canSeeCredit}
      />
    </div>
  );
}
