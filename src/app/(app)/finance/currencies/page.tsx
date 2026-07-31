import { CurrencyBoard } from '@/components/finance/currency-board';
import { withPageScope } from '@/lib/api/page';
import {
  listCurrencies,
  listExchangeRates,
} from '@/lib/application/services/currency-service';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'العملات وأسعار الصرف' };

export default async function Page(): Promise<JSX.Element> {
  const { currencies, rates, canEdit } = await withPageScope(async (context) => ({
    currencies: await listCurrencies(context.tenantId),
    rates: await listExchangeRates({ tenantId: context.tenantId }),
    canEdit: context.permissions.can('finance.account', 'update'),
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">العملات وأسعار الصرف</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          العملات المعرَّفة للمنشأة، والعملة الأساسية التي تُمسك بها الدفاتر، وأسعار الصرف المؤرَّخة
        </p>
      </header>

      <CurrencyBoard currencies={currencies} rates={rates} canEdit={canEdit} />
    </div>
  );
}
