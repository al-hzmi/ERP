import { BankReconciliation } from '@/components/treasury/bank-reconciliation';

export const metadata = { title: 'التسوية البنكية' };

/**
 * Bank reconciliation.
 *
 * `bank_statements` and `bank_statement_lines` shipped in migration 1 and nothing ever
 * wrote to them. `bank-reconciliation-service.ts` drives them, migration 007 adds the
 * constraints they never had, and this is what a treasury clerk sees.
 */
export default function BankReconciliationPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">التسوية البنكية</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مطابقة حركات كشف الحساب بسندات القبض والصرف، حتى لا يتبقى فرق غير مُفسَّر.
        </p>
      </header>

      <BankReconciliation />
    </div>
  );
}
