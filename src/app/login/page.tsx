'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AlertCircle, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Sign-in.
 *
 * The form surfaces whatever bilingual message the API returned rather than
 * inventing its own — so a locked account, a rate limit and a wrong password
 * each say something specific and true, and the wording lives in one place.
 */
export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const payload: unknown = await response.json();

      if (!response.ok) {
        const message = (payload as { error?: { messageAr?: string } }).error?.messageAr;
        setError(message ?? 'تعذر تسجيل الدخول. يرجى المحاولة مرة أخرى.');
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      // A network failure is not a credentials failure, and telling the user it
      // is would send them chasing a password that was never wrong.
      setError('تعذر الاتصال بالخادم. تحقق من اتصالك وحاول مجدداً.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Scale className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">نظام تخطيط موارد المؤسسة</h1>
          <p className="mt-1 text-sm text-muted-foreground">سجّل الدخول للمتابعة</p>
        </div>

        <form onSubmit={onSubmit} className="card-surface space-y-4 p-6">
          <div className="space-y-1.5">
            <label htmlFor="username" className="text-sm font-medium">
              اسم المستخدم
            </label>
            <input
              id="username"
              name="username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              required
              autoComplete="username"
              dir="ltr"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              كلمة المرور
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              required
              autoComplete="current-password"
              dir="ltr"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>

          {error !== null ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <Button type="submit" loading={submitting} className="w-full">
            تسجيل الدخول
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          بيانات العرض التوضيحي: <span className="bidi-isolate font-mono">admin</span> /{' '}
          <span className="bidi-isolate font-mono">Erp@Demo2026!</span>
        </p>
      </div>
    </main>
  );
}
