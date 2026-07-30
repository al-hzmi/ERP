import { WifiOff } from 'lucide-react';

export const metadata = { title: 'لا يوجد اتصال' };

/**
 * The offline fallback, precached by the service worker.
 *
 * Reached only when a navigation cannot be served and no cached copy of that page exists.
 * It is a static page on purpose — anything that queried would fail in exactly the
 * situation this page exists for.
 */
export default function OfflinePage(): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <WifiOff className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-xl font-semibold">لا يوجد اتصال بالإنترنت</h1>
      <p className="text-sm text-muted-foreground">
        هذه الصفحة غير متوفرة دون اتصال. المسودات التي أدخلتها محفوظة على هذا الجهاز
        وستُرسل تلقائياً عند عودة الاتصال.
      </p>
      <p className="text-xs text-muted-foreground">
        لم تُفقد أي بيانات — العمليات غير المُرسلة تنتظر في طابور الإرسال.
      </p>
    </main>
  );
}
