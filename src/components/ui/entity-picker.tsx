'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { apiFetch } from '@/lib/utils/api-client';
import { cn } from '@/lib/utils/cn';

/**
 * A search-as-you-type picker over an entity the tenant has thousands of.
 *
 * A `<select>` is the right control for eight branches and the wrong one for five
 * thousand products, so this is the other half of that decision: it queries
 * `/api/search`, which already ranks exact over prefix over substring over trigram,
 * meaning typing `1001` finds `BTC-1001` and a typo still finds the product.
 *
 * Two things it does that a naive version does not:
 *
 *   - **Debounces, and discards stale answers.** Without the second part, typing
 *     `ورق` then `ورقة` can render the results for `ورق` if they arrive later — the
 *     race is invisible on a fast connection and constant on a slow one.
 *   - **Keeps the chosen label after the list closes.** A picker that shows an id, or
 *     goes blank once dismissed, makes the user re-search to check what they picked.
 */

export type PickerEntity = 'product' | 'counterparty' | 'account';

interface SearchHit {
  readonly entity: string;
  readonly id: string;
  readonly code: string;
  readonly titleAr: string;
  readonly subtitle: string | null;
}

export interface EntityPickerProps {
  entity: PickerEntity;
  value: string;
  /** The label to show for an already-chosen value, so it survives a remount. */
  valueLabel?: string;
  onSelect: (selection: { id: string; label: string; code: string }) => void;
  placeholder?: string;
  invalid?: boolean;
  id?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
}

export function EntityPicker({
  entity,
  value,
  valueLabel,
  onSelect,
  placeholder = 'ابحث بالرمز أو الاسم…',
  invalid = false,
  id,
  disabled = false,
  ...aria
}: EntityPickerProps): JSX.Element {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = term.trim();
    if (query === '') {
      setHits([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    // `cancelled` is the discard: a response that arrives after the term moved on is
    // an answer to a question nobody is asking any more.
    let cancelled = false;

    const timer = setTimeout(() => {
      void apiFetch<{ query: string; results: SearchHit[] }>(
        `/api/search?q=${encodeURIComponent(query)}&entities=${entity}`,
      ).then((result) => {
        if (cancelled) return;
        setLoading(false);
        // The endpoint is federated and returns every permitted entity type ranked
        // together; a picker wants one of them.
        setHits(result.ok ? result.data.results.filter((hit) => hit.entity === entity) : []);
        setHighlighted(0);
      });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, entity]);

  // A click anywhere else closes the list. Without this the results stay open behind
  // the next field the user moves to.
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  function choose(hit: SearchHit): void {
    onSelect({ id: hit.id, label: hit.titleAr, code: hit.code });
    setTerm('');
    setHits([]);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open || hits.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      const hit = hits[highlighted];
      if (hit !== undefined) {
        // Enter inside a picker chooses a row; it must not also submit the form the
        // picker happens to be sitting in.
        event.preventDefault();
        choose(hit);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  const chosen = value !== '' && valueLabel !== undefined && valueLabel !== '';

  return (
    <div ref={containerRef} className="relative">
      {chosen ? (
        <div
          className={cn(
            'flex h-10 items-center justify-between gap-2 rounded-md border bg-muted/40 px-3',
            invalid ? 'border-destructive' : 'border-input',
          )}
        >
          <span className="truncate text-sm">{valueLabel}</span>
          {disabled ? null : (
            <button
              type="button"
              onClick={() => {
                onSelect({ id: '', label: '', code: '' });
                setOpen(true);
              }}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="تغيير الاختيار"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Search
            className="pointer-events-none absolute inset-inline-start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-invalid={invalid || undefined}
            disabled={disabled}
            value={term}
            placeholder={placeholder}
            onChange={(event) => {
              setTerm(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className={cn(
              'h-10 w-full rounded-md border bg-background px-3 ps-9 text-sm',
              'placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              invalid ? 'border-destructive' : 'border-input',
            )}
            {...aria}
          />
        </div>
      )}

      {open && !chosen && term.trim() !== '' ? (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover shadow-lg"
        >
          {loading && hits.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">جارٍ البحث…</li>
          ) : null}

          {!loading && hits.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">لا توجد نتائج</li>
          ) : null}

          {hits.map((hit, index) => (
            <li key={hit.id} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                // `mousedown` rather than `click`: the input's blur fires first and
                // would close the list before a click could land on it.
                onMouseDown={() => choose(hit)}
                onMouseEnter={() => setHighlighted(index)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm',
                  index === highlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {hit.titleAr}
                  {hit.subtitle !== null ? (
                    <span className="ms-2 text-xs text-muted-foreground">{hit.subtitle}</span>
                  ) : null}
                </span>
                <span className="bidi-isolate shrink-0 font-mono text-xs text-primary">
                  {hit.code}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
