import { notFound } from 'next/navigation';
import { InvoiceDetailView } from '@/components/sales/invoice-detail';
import { withPageScope } from '@/lib/api/page';
import { getInvoiceDetail } from '@/lib/application/services/invoice-detail-service';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<{ title: string }> {
  const invoice = await withPageScope(async (context) =>
    getInvoiceDetail(context.tenantId, params.id),
  );
  return { title: invoice?.documentNumber ?? 'فاتورة مبيعات' };
}

/**
 * One sales invoice.
 *
 * `notFound()` rather than an error for a missing id, and the lookup is tenant-scoped, so an id
 * belonging to another tenant is indistinguishable from one that does not exist — which is the
 * only answer that does not confirm the row is real.
 */
export default async function Page({ params }: { params: { id: string } }): Promise<JSX.Element> {
  const { invoice, canPost } = await withPageScope(async (context) => ({
    invoice: await getInvoiceDetail(context.tenantId, params.id),
    canPost: context.permissions.can('sales.invoice', 'post'),
  }));

  if (invoice === null) notFound();

  return <InvoiceDetailView invoice={invoice} canPost={canPost} />;
}
