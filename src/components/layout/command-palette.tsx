'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CornerDownLeft, Loader2, Search, SquareDashed } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { rankCommands, type Command } from '@/lib/search/command-registry';

/**
 * The command palette.
 *
 * Ctrl/Cmd+K from anywhere. It answers two different questions with one input, and keeping
 * them in one list rather than two panes is the point: a user typing "فوات" does not know yet
 * whether they want the register, a new invoice, or invoice number 1038, and making them
 * choose a tab first is the tax this control exists to remove.
 *
 * ## Two sources, two latencies, one list
 *
 * Commands (actions and screens) are ranked in the browser from a static registry — instant,
 * no request. Records (products, customers, invoices) come from `/api/search` behind a 200 ms
 * debounce. The commands render on the first keystroke and the records fill in underneath, so
 * the palette is never blank while something is in flight. A single combined list that waited
 * for the network would feel slower than the search box it replaced.
 *
 * ## Keyboard, and why the index is flat
 *
 * `items` is the flattened, ordered list the arrow keys walk. Sections are a rendering
 * concern layered on top. Holding the highlight as a section-plus-offset pair means every
 * arrow press has to reason about section boundaries, and the bug that follows is the
 * highlight skipping the first row of a section — which is exactly the row it should land on.
 *
 * ## Accessibility
 *
 * `role="dialog"` with `aria-modal`, a labelled combobox, `aria-activedescendant` pointing at
 * the highlighted option, and focus returned to whatever opened it. The highlighted row is
 * scrolled into view on every change, because a keyboard user who cannot see the highlight is
 * navigating blind.
 */

interface SearchHit {
  entity: string;
  id: string;
  code: string;
  titleAr: string;
  titleEn: string;
  subtitle: string | null;
  score: number;
  href: string | null;
}

const ENTITY_LABELS: Record<string, string> = {
  product: 'صنف',
  counterparty: 'طرف',
  account: 'حساب',
  document: 'مستند',
  employee: 'موظف',
};

/** A row in the flat, keyboard-navigable list. */
type PaletteItem =
  | { kind: 'command'; id: string; command: Command }
  | { kind: 'hit'; id: string; hit: SearchHit };

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const router = useRouter();

  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [highlighted, setHighlighted] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the palette opened, so Escape can hand it back.
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // Reset on every open. A palette that reopens showing the last search is showing a stale
  // answer to a question nobody asked twice.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    setTerm('');
    setDebounced('');
    setHighlighted(0);
    // After paint, or the input is not in the document yet.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // 200 ms: short enough to feel immediate, long enough that "BTC-1038" is one request
  // rather than eight rendered out of order.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 200);
    return () => clearTimeout(timer);
  }, [term]);

  const commands = useMemo(() => rankCommands(term, 6), [term]);

  const { data, isFetching } = useQuery({
    queryKey: ['command-palette', debounced],
    // Two characters, not one: a single letter matches most of the catalogue and the
    // response is noise the user has to read past.
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
    queryFn: async (): Promise<SearchHit[]> => {
      const response = await fetch(`/api/search?q=${encodeURIComponent(debounced)}`);
      if (!response.ok) return [];
      const body: unknown = await response.json();
      const results = (body as { data?: { results?: SearchHit[] } }).data?.results;
      return results ?? [];
    },
  });

  const hits = data ?? [];

  // The flat list the keyboard walks: commands first, then records.
  const items = useMemo<PaletteItem[]>(
    () => [
      ...commands.map((scored) => ({
        kind: 'command' as const,
        id: scored.command.id,
        command: scored.command,
      })),
      ...hits.map((hit) => ({ kind: 'hit' as const, id: `${hit.entity}:${hit.id}`, hit })),
    ],
    [commands, hits],
  );

  // Results change under the highlight as the query lands. Clamping rather than resetting to
  // zero keeps the selection where the user put it whenever the list is still long enough.
  useEffect(() => {
    setHighlighted((current) => (current >= items.length ? Math.max(0, items.length - 1) : current));
  }, [items.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, items.length]);

  function choose(item: PaletteItem): void {
    const href = item.kind === 'command' ? item.command.href : item.hit.href;
    if (href === null || href === undefined) return;
    onClose();
    router.push(href);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => (items.length === 0 ? 0 : (current + 1) % items.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) =>
        items.length === 0 ? 0 : (current - 1 + items.length) % items.length,
      );
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setHighlighted(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setHighlighted(Math.max(0, items.length - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[highlighted];
      if (item !== undefined) choose(item);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      restoreFocusTo.current?.focus();
    }
  }

  if (!open) return null;

  const commandCount = commands.length;
  const showEmpty =
    term.trim() !== '' && items.length === 0 && !isFetching && debounced.length >= 2;

  return (
    <div
      className="no-print fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="لوحة الأوامر"
    >
      {/* The backdrop is its own element and its own animation: it fades while the panel
          rises, which is what makes the panel read as floating above the page. */}
      <button
        type="button"
        aria-label="إغلاق"
        onClick={onClose}
        className="absolute inset-0 animate-overlay-in cursor-default bg-background/60 backdrop-blur-sm"
      />

      <div
        className={cn(
          'relative w-full max-w-2xl animate-palette-in overflow-hidden rounded-xl',
          'border border-border bg-card shadow-2xl shadow-black/20',
          'ring-1 ring-black/5 dark:shadow-black/60',
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          {isFetching ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}

          <input
            ref={inputRef}
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="ابحث عن شاشة أو صنف أو عميل أو فاتورة، أو اكتب أمراً…"
            className="h-14 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={
              items[highlighted] === undefined ? undefined : `cmd-${highlighted}`
            }
            // The browser's own suggestions would cover the palette's.
            autoComplete="off"
            spellCheck={false}
          />

          <kbd className="hidden shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="النتائج"
          className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-2"
        >
          {term.trim() === '' ? (
            <Hint />
          ) : showEmpty ? (
            <Empty term={term} />
          ) : (
            <>
              {commandCount > 0 ? (
                <Section label="أوامر وشاشات">
                  {commands.map((scored, index) => (
                    <Row
                      key={scored.command.id}
                      index={index}
                      active={highlighted === index}
                      onHover={() => setHighlighted(index)}
                      onSelect={() => choose(items[index] as PaletteItem)}
                      icon={<scored.command.icon className="h-4 w-4" aria-hidden="true" />}
                      title={scored.command.labelAr}
                      subtitle={scored.command.groupAr}
                      trailing={
                        scored.command.kind === 'action' ? (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            إنشاء
                          </span>
                        ) : null
                      }
                    />
                  ))}
                </Section>
              ) : null}

              {hits.length > 0 ? (
                <Section label="السجلات">
                  {hits.map((hit, offset) => {
                    const index = commandCount + offset;
                    return (
                      <Row
                        key={`${hit.entity}:${hit.id}`}
                        index={index}
                        active={highlighted === index}
                        disabled={hit.href === null}
                        onHover={() => setHighlighted(index)}
                        onSelect={() => choose(items[index] as PaletteItem)}
                        icon={
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {ENTITY_LABELS[hit.entity] ?? hit.entity}
                          </span>
                        }
                        title={hit.titleAr}
                        subtitle={hit.code}
                        trailing={
                          hit.href === null ? (
                            <span className="text-[10px] text-muted-foreground">لا توجد شاشة</span>
                          ) : hit.subtitle !== null ? (
                            <span className="bidi-isolate text-[11px] text-muted-foreground">
                              {hit.subtitle}
                            </span>
                          ) : null
                        }
                      />
                    );
                  })}
                </Section>
              ) : null}

              {isFetching && hits.length === 0 && debounced.length >= 2 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  جارٍ البحث في السجلات…
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          <Legend keys="↑ ↓" label="تنقّل" />
          <Legend icon={<CornerDownLeft className="h-3 w-3" aria-hidden="true" />} label="فتح" />
          <Legend keys="Esc" label="إغلاق" />
          <span className="ms-auto hidden sm:inline">
            {items.length > 0 ? `${items.length} نتيجة` : null}
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-1 last:mb-0">
      <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({
  index,
  active,
  disabled = false,
  onHover,
  onSelect,
  icon,
  title,
  subtitle,
  trailing,
}: {
  index: number;
  active: boolean;
  disabled?: boolean;
  onHover: () => void;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  trailing?: React.ReactNode;
}): JSX.Element {
  return (
    <div
      id={`cmd-${index}`}
      data-index={index}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      onMouseMove={onHover}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm transition-colors',
        disabled ? 'cursor-default opacity-55' : 'cursor-pointer',
        active && !disabled ? 'bg-accent text-accent-foreground' : 'text-foreground/85',
      )}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground">
        {icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="bidi-isolate block truncate text-[11px] text-muted-foreground">
          {subtitle}
        </span>
      </span>

      {trailing !== null && trailing !== undefined ? (
        <span className="shrink-0">{trailing}</span>
      ) : null}

      {active && !disabled ? (
        <ArrowLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
    </div>
  );
}

/** What the palette shows before anything is typed — the shortcut, not an empty box. */
function Hint(): JSX.Element {
  return (
    <div className="px-3 py-8 text-center">
      <SquareDashed className="mx-auto mb-3 h-6 w-6 text-muted-foreground/50" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">اكتب للبحث</p>
      <p className="mt-1 text-xs text-muted-foreground/70">
        الشاشات والأوامر فوراً، والأصناف والعملاء والفواتير بعد حرفين
      </p>
    </div>
  );
}

function Empty({ term }: { term: string }): JSX.Element {
  return (
    <div className="px-3 py-8 text-center">
      <p className="text-sm">
        لا توجد نتائج لـ <span className="bidi-isolate font-medium">{term}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        البحث يتجاهل الشرطات ويوحّد الألف والتاء المربوطة والأرقام العربية — جرّب كلمة أقصر
      </p>
    </div>
  );
}

function Legend({
  keys,
  icon,
  label,
}: {
  keys?: string;
  icon?: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="rounded border border-border bg-background px-1 py-0.5 font-sans text-[10px]">
        {keys ?? icon}
      </kbd>
      {label}
    </span>
  );
}
