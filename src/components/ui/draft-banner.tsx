'use client';

import { Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/utils/format';

/**
 * "You left something unfinished."
 *
 * Offered rather than applied, which is the whole design decision. Restoring silently
 * means someone who came to raise a new invoice starts editing last Thursday's without
 * being told, and the first they learn of it is a customer name they did not type.
 *
 * Both actions are explicit and both are final in the direction they claim: restoring
 * fills the form, discarding deletes the stored draft. There is no third state where the
 * banner is dismissed but the draft lingers to surprise them on the next visit.
 */
export function DraftBanner({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Clock className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0">
          <span className="font-medium">لديك مسودة غير مكتملة</span>{' '}
          <span className="text-muted-foreground">
            {/* Relative rather than absolute: "منذ ساعة" answers the question the user
                actually has — is this recent enough to be the thing I was doing. */}
            محفوظة على هذا الجهاز {formatRelativeTime(new Date(savedAt))}
          </span>
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={onRestore}>
          استعادة
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          aria-label="تجاهل المسودة وحذفها"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          تجاهل
        </Button>
      </div>
    </div>
  );
}
