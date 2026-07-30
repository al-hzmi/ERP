import { InvoiceForm } from '@/components/sales/invoice-form';

export const metadata = { title: 'فاتورة مبيعات جديدة' };

/**
 * The invoice entry screen.
 *
 * A thin server shell around a client form. The form is interactive by nature —
 * lines are added, removed and totalled as the user types — so it cannot be a server
 * component; the shell exists so the page still renders its heading server-side and
 * inherits the authenticated layout's tenant scope.
 */
export default function NewSalesInvoicePage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">فاتورة مبيعات جديدة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          أدخل بيانات الفاتورة وبنودها. الإجماليات تُحسب فوراً بحساب عشري دقيق.
        </p>
      </header>

      <InvoiceForm />
    </div>
  );
}
