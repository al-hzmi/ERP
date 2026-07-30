import { StockCardView } from '@/components/inventory/stock-card-view';

export const metadata = { title: 'بطاقة الصنف' };

/**
 * The item card.
 *
 * Reads `balanceAfter`, which the inventory service maintains per movement under a row
 * lock, so the running balance column is the one the ledger actually recorded rather
 * than one this screen recomputed and hoped would agree.
 */
export default function StockCardPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">بطاقة الصنف</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          حركات صنف واحد في مستودع واحد، بالرصيد الجاري كما سُجّل لحظة كل حركة.
        </p>
      </header>

      <StockCardView />
    </div>
  );
}
