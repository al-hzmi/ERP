'use client';

import { CloudOff, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOnlineStatus, useSubmissionQueue } from '@/lib/offline/hooks';
import { MAX_ATTEMPTS } from '@/lib/offline/queue';

/**
 * The connection banner and the queue behind it.
 *
 * Only rendered when there is something to say — offline, or work waiting to be sent.
 * A permanent "you are online" indicator is noise that trains people to ignore the strip
 * it lives in, which is the strip that has to be believed when it does matter.
 *
 * The wording distinguishes three states that a single "syncing" message would blur, and
 * the difference matters to whoever has to explain a missing invoice tomorrow:
 *
 *   - offline with nothing queued — informational;
 *   - work waiting to be sent — not filed yet, and the user should know before leaving;
 *   - a submission the server *refused* — it will never send itself, and someone has to
 *     look at it.
 */
export function OfflineBar(): JSX.Element | null {
  const online = useOnlineStatus();
  const { pending, flushing, flush, discard } = useSubmissionQueue();

  const stuck = pending.filter(
    (entry) => entry.failure !== undefined || entry.attempts >= MAX_ATTEMPTS,
  );
  const waiting = pending.filter((entry) => !stuck.includes(entry));

  if (online && pending.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="space-y-2 px-4 pt-3 sm:px-6">
      {!online ? (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm">
          <WifiOff className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0">
            <span className="font-medium">لا يوجد اتصال.</span>{' '}
            <span className="text-muted-foreground">
              يمكنك متابعة الإدخال — تُحفظ المسودات محلياً وتُرسل عند عودة الاتصال.
            </span>
          </p>
        </div>
      ) : null}

      {waiting.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm">
          <div className="flex min-w-0 items-center gap-3">
            <CloudOff className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <p className="min-w-0">
              <span className="font-medium">{waiting.length} عملية بانتظار الإرسال.</span>{' '}
              <span className="text-muted-foreground">لم تُسجَّل في النظام بعد.</span>
            </p>
          </div>
          {online ? (
            <Button variant="outline" size="sm" loading={flushing} onClick={flush}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              إرسال الآن
            </Button>
          ) : null}
        </div>
      ) : null}

      {stuck.map((entry) => (
        <div
          key={entry.key}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm"
        >
          <p className="min-w-0">
            <span className="font-medium text-destructive">تعذّر إرسال عملية.</span>{' '}
            <span className="text-muted-foreground">
              {entry.failure?.messageAr ??
                `فشلت ${entry.attempts} محاولات. لن تُعاد المحاولة تلقائياً.`}
            </span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => discard(entry.key)}
            aria-label="حذف العملية المتعذّرة"
          >
            <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
            حذف
          </Button>
        </div>
      ))}
    </div>
  );
}
