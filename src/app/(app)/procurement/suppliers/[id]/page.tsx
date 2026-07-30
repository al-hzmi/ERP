import { notFound } from 'next/navigation';
import { CounterpartyCardView } from '@/components/master-data/counterparty-card';
import { withPageScope } from '@/lib/api/page';
import { getCounterpartyCard } from '@/lib/application/services/counterparty-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'البطاقة' };

/**
 * One counterparty, its ageing and its open exposure.
 *
 * `notFound()` on a miss rather than an error: another tenant's record and a non-existent one
 * are indistinguishable from here, and they should be — distinguishing them would confirm the
 * id exists somewhere.
 */
export default async function Page({ params }: { params: { id: string } }): Promise<JSX.Element> {
  const result = await withPageScope(async (context) => {
    const card = await getCounterpartyCard({
      tenantId: context.tenantId,
      counterpartyId: params.id,
      kind: 'SUPPLIER',
    });

    return {
      card,
      canSeeCredit: context.permissions.can('sales.customer', 'read', 'creditLimit'),
    };
  });

  if (!result.card.ok) notFound();

  return (
    <CounterpartyCardView
      data={result.card.value}
      kind="SUPPLIER"
      basePath="/procurement/suppliers"
      canSeeCredit={result.canSeeCredit}
    />
  );
}
