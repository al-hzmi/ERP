'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * The command palette.
 *
 * Two behaviours make or break a search box like this:
 *
 *  1. **Debouncing.** Querying on every keystroke sends eight requests for
 *     "BTC-1001" and renders the results out of order. 220 ms is short enough to
 *     feel immediate and long enough to collapse a burst of typing into one call.
 *  2. **Keyboard control.** Arrow keys and Enter, because the people who use
 *     this system all day do not reach for the mouse.
 */

interface SearchHit {
  entity: string;
  id: string;
  code: string;
  titleAr: string;
  titleEn: string;
  subtitle: string | null;
  score: number;
  /**
   * `null` when nothing has been built to navigate to.
   *
   * Six of the seven destinations this used to produce were routes that had never been
   * written, so pressing Enter on a search result was a 404. The hit is still returned —
   * it confirms the record exists and shows its code, name and balance — but it renders as
   * a plain row rather than a link.
   */
  href: string | null;
}

const ENTITY_LABELS: Record<string, string> = {
  product: 'صنف',
  counterparty: 'طرف',
  account: 'حساب',
  document: 'مستند',
  employee: 'موظف',
};

export function GlobalSearch({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(term.trim());
    }, 220);
    return () => {
      clearTimeout(timer);
    };
  }, [term]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setHighlighted(0);
    } else {
      setTerm('');
      setDebounced('');
    }
  }, [open]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    enabled: open && debounced.length >= 1,
    queryFn: async (): Promise<SearchHit[]> => {
      const response = await fetch(`/api/search?q=${encodeURIComponent(debounced)}`);
      if (!response.ok) return [];
      const payload: unknown = await response.json();
      const results = (payload as { data?: { results?: SearchHit[] } }).data?.results;
      return results ?? [];
    },
  });

  const hits = data ?? [];

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, hits.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    }
    if (event.key === 'Enter') {
      const target = hits[highlighted];
      // Guarded, not assumed. A hit with no destination stays put instead of navigating to
      // the string "null".
      if (target?.href != null && target.href !== '') {
        window.location.href = target.href;
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/30 px-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="البحث الشامل"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover shadow-2xl animate-fade-in"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="اكتب رقم صنف، اسم عميل، أو رقم فاتورة…"
            className="h-14 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="نص البحث"
            autoComplete="off"
          />
          {isFetching ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : null}
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2">
          {debounced === '' ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              يكفي جزء من الرقم — كتابة <span className="bidi-isolate font-mono">1001</span> تجد{' '}
              <span className="bidi-isolate font-mono">BTC-1001</span>
            </p>
          ) : hits.length === 0 && !isFetching ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              لا توجد نتائج مطابقة
            </p>
          ) : (
            <ul>
              {hits.map((hit, index) => {
                const body = (
                  <>
                    <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {ENTITY_LABELS[hit.entity] ?? hit.entity}
                    </span>
                    <span className="bidi-isolate shrink-0 font-mono text-xs text-primary">
                      {hit.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{hit.titleAr}</span>
                    {hit.subtitle !== null ? (
                      <span className="numeric shrink-0 text-xs text-muted-foreground">
                        {hit.subtitle}
                      </span>
                    ) : null}
                  </>
                );

                const rowClass = cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
                  index === highlighted ? 'bg-accent' : 'hover:bg-accent/60',
                );

                return (
                  <li key={`${hit.entity}-${hit.id}`}>
                    {hit.href === null ? (
                      // No screen to open. Shown, because confirming the record exists and
                      // reading its code is most of what a search is for — but not as a link,
                      // because a link that 404s is worse than no link at all.
                      <div
                        className={cn(rowClass, 'cursor-default')}
                        onMouseEnter={() => {
                          setHighlighted(index);
                        }}
                      >
                        {body}
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] text-muted-foreground">
                          لا توجد شاشة
                        </span>
                      </div>
                    ) : (
                      <Link
                        href={hit.href}
                        onClick={onClose}
                        onMouseEnter={() => {
                          setHighlighted(index);
                        }}
                        className={rowClass}
                      >
                        {body}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>↑ ↓ للتنقل · Enter للفتح · Esc للإغلاق</span>
          <span>بحث ضبابي يتحمل الأخطاء الإملائية</span>
        </div>
      </div>
    </div>
  );
}
