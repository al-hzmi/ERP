'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronsLeftRight, Moon, Scale, Search, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { OfflineBar } from './offline-bar';
import { cn } from '@/lib/utils/cn';
import { useUiStore } from '@/store/ui-store';
import { CommandPalette } from './command-palette';
import {
  activeModuleFor,
  GROUP_LABELS,
  NAVIGATION,
  type NavItem,
} from '@/lib/navigation';

/**
 * The application frame: a right-hand sidebar, a header, and the page.
 *
 * The sidebar sits on the right because the document direction is RTL — it is
 * positioned with logical properties (`start`/`end`) rather than left/right, so
 * switching the interface to English moves it without a single CSS override.
 */

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: { fullNameAr: string; fullNameEn: string; tenantNameAr: string } | null;
}): JSX.Element {
  const pathname = usePathname();
  const { locale, theme, sidebarCollapsed, toggleTheme, toggleSidebar } = useUiStore();
  const [searchOpen, setSearchOpen] = useState(false);

  const activeModule = activeModuleFor(pathname);

  // Seeded with the module the current page belongs to, so arriving on a screen shows where
  // you are rather than a wall of closed sections. Multiple sections may stay open at once:
  // an accountant moving between the journal register and the trial balance should not have
  // the first collapse under them.
  const [openModules, setOpenModules] = useState<ReadonlySet<string>>(
    () => new Set(activeModule !== null ? [activeModule] : [NAVIGATION[0]?.titleEn ?? '']),
  );

  // Following a link into another module opens it. Without this, navigating from the sidebar
  // to a screen in a closed section leaves the tree pointing somewhere else entirely.
  useEffect(() => {
    if (activeModule === null) return;
    setOpenModules((previous) => {
      if (previous.has(activeModule)) return previous;
      return new Set([...previous, activeModule]);
    });
  }, [activeModule]);

  function toggleModule(title: string): void {
    setOpenModules((previous) => {
      const next = new Set(previous);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }

  // Ctrl/Cmd+K opens the palette from anywhere — the shortcut every user of a system like
  // this already has in their fingers.
  //
  // Escape is deliberately *not* handled here any more. The palette owns its own Escape so
  // it can hand focus back to whatever opened it; a second handler on the window closed it
  // first, and focus was left on the body with nothing to tab from.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      // Toggling, not opening: pressing the shortcut again is how people close it, and
      // re-opening an already-open palette would reset a query they were halfway through.
      setSearchOpen((current) => !current);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          'no-print sticky top-0 flex h-screen shrink-0 flex-col border-e border-border bg-card',
          'transition-[width] duration-200 ease-out',
          sidebarCollapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b border-border px-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Scale className="h-5 w-5" aria-hidden="true" />
          </div>
          {!sidebarCollapsed ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">
                {user?.tenantNameAr ?? 'نظام تخطيط الموارد'}
              </p>
              <p className="text-xs text-muted-foreground">ERP</p>
            </div>
          ) : null}
        </div>

        <nav
          className="flex-1 space-y-1 overflow-y-auto px-3 py-4"
          aria-label="التنقل الرئيسي"
        >
          {NAVIGATION.map((module) => {
            const expanded = openModules.has(module.titleEn);
            const ModuleIcon = module.icon;
            const title = locale === 'ar' ? module.titleAr : module.titleEn;
            const panelId = `nav-panel-${module.titleEn.replace(/\W+/g, '-').toLowerCase()}`;

            // Collapsed rail: the accordion has nowhere to expand into, so the module icon
            // becomes the affordance and clicking it opens the sidebar rather than a panel
            // nobody can read.
            if (sidebarCollapsed) {
              return (
                <button
                  key={module.titleEn}
                  type="button"
                  onClick={toggleSidebar}
                  title={title}
                  className={cn(
                    'flex w-full items-center justify-center rounded-md py-2.5 transition-colors',
                    activeModule === module.titleEn
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground/70 hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <ModuleIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                  <span className="sr-only">{title}</span>
                </button>
              );
            }

            return (
              <div key={module.titleEn}>
                <button
                  type="button"
                  onClick={() => {
                    toggleModule(module.titleEn);
                  }}
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors',
                    activeModule === module.titleEn
                      ? 'font-medium text-primary'
                      : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <ModuleIcon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  <span className="truncate">{title}</span>
                  <ChevronDown
                    className={cn(
                      'ms-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                      expanded && 'rotate-180',
                    )}
                    aria-hidden="true"
                  />
                </button>

                {expanded ? (
                  <div id={panelId} className="mt-1 space-y-3 pb-2 ps-3">
                    {module.groups.map((group) => (
                      <div key={group.kind}>
                        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                          {locale === 'ar' ? GROUP_LABELS[group.kind].ar : GROUP_LABELS[group.kind].en}
                        </p>
                        <ul className="space-y-0.5 border-s border-border ps-2">
                          {group.items.map((item) => (
                            <NavRow
                              key={`${item.labelEn}-${item.href ?? 'planned'}`}
                              item={item}
                              locale={locale}
                              pathname={pathname}
                            />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={toggleSidebar}
          className="flex items-center gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground hover:bg-accent"
          aria-label={sidebarCollapsed ? 'توسيع القائمة' : 'طي القائمة'}
        >
          <ChevronsLeftRight className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          {!sidebarCollapsed ? <span>طي القائمة</span> : null}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-border bg-background/85 px-6 backdrop-blur">
          <button
            type="button"
            onClick={() => {
              setSearchOpen(true);
            }}
            className="flex h-9 min-w-0 flex-1 max-w-md items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">ابحث أو نفّذ أمراً…</span>
            <kbd className="ms-auto hidden shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] sm:inline">
              Ctrl K
            </kbd>
          </button>

          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              aria-label={theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'}
            >
              {theme === 'dark' ? (
                <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
              ) : (
                <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>

            {user !== null ? (
              <div className="flex items-center gap-3 border-s border-border ps-3">
                <div className="hidden text-end sm:block">
                  <p className="text-sm font-medium leading-tight">{user.fullNameAr}</p>
                  <p className="text-xs text-muted-foreground">{user.fullNameEn}</p>
                </div>
                <div className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {user.fullNameAr.charAt(0)}
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {/* Above the content rather than pinned: a banner that overlays the page hides
            the field someone is typing into, and this one appears while they type. */}
        <OfflineBar />

        <main className="flex-1 px-6 py-6">{children}</main>
      </div>

      <CommandPalette
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
        }}
      />
    </div>
  );
}

/**
 * One row in a module's list — a link, or a planned screen that is deliberately not one.
 *
 * The two branches are the point. An item with an `href` renders an anchor; an item without
 * renders a `<span>` and nothing else. There is no third case where a planned screen gets a
 * disabled anchor, because "disabled" on an anchor is decoration: `pointer-events-none` stops
 * a mouse click and nothing else, leaving middle-click, keyboard focus and a screen reader's
 * link list all pointing at a URL that answers 404. `aria-disabled` on an `<a href>` is worse
 * still — it announces the control as unavailable while leaving it fully operable.
 */
function NavRow({
  item,
  locale,
  pathname,
}: {
  item: NavItem;
  locale: 'ar' | 'en';
  pathname: string;
}): JSX.Element {
  const Icon = item.icon;
  const label = locale === 'ar' ? item.labelAr : item.labelEn;

  if (item.href === undefined) {
    return (
      <li>
        <span
          className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground/55"
          title={locale === 'ar' ? 'لم تُنفَّذ بعد' : 'Not implemented yet'}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <span className="ms-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
            {locale === 'ar' ? 'قريباً' : 'Soon'}
          </span>
        </span>
      </li>
    );
  }

  // Exact match, not `startsWith`. A prefix test marks "القيود المحاسبية" as current while the
  // user is on "قيد جديد", so two rows claim to be the page at once.
  const active = pathname === item.href;

  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
          active
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-foreground/75 hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}
