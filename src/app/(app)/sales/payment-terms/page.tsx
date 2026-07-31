import { PaymentTermsTable } from '@/components/commercial/payment-terms-table';
import { withPageScope } from '@/lib/api/page';
import { listPaymentTerms } from '@/lib/application/services/commercial-setup-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'شروط الدفع' };

export default async function Page({
  searchParams,
}: {
  searchParams: { inactive?: string };
}): Promise<JSX.Element> {
  const includeInactive = searchParams.inactive === 'true';

  const { terms, canEdit } = await withPageScope(async (context) => ({
    terms: await listPaymentTerms({ tenantId: context.tenantId, includeInactive }),
    canEdit: context.permissions.can('sales.customer', 'create'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">شروط الدفع</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مدد السداد الممنوحة للعملاء والموردين، وخصومات السداد المبكر
        </p>
      </header>

      <PaymentTermsTable terms={terms} canEdit={canEdit} includeInactive={includeInactive} />
    </div>
  );
}
