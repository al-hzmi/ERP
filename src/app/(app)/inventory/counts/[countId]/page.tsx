import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { StockCountSheet } from '@/components/inventory/stock-count-sheet';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'ورقة الجرد' };

/**
 * One count sheet.
 *
 * A client component below the header, unlike the other registers, because this screen is
 * genuinely interactive: quantities are typed line by line, the variance updates as they are,
 * and the difference between an unsaved edit and a saved one has to be visible while typing.
 * Server rendering that would mean a round trip per keystroke.
 */
export default function StockCountPage({ params }: { params: { countId: string } }): JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/inventory/counts"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          عودة إلى عمليات الجرد
        </Link>
      </div>

      <StockCountSheet countId={params.countId} />
    </div>
  );
}
