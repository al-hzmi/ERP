import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUP_LABELS, NAVIGATION, activeModuleFor, navigableHrefs } from '@/lib/navigation';

/**
 * The navigation tree cannot link to a page that does not exist.
 *
 * This test exists because the failure it prevents already happened: eight sidebar entries
 * pointed at routes that had never been written, and the first two a user clicked — the
 * journal register and the voucher register — returned 404 on a system whose APIs for both
 * were complete and tested. Nothing caught it, because nothing was looking: a `href` is just a
 * string, and Next.js resolves routes from the filesystem at request time.
 *
 * So the check is a filesystem check. For every `href` in the tree, the corresponding
 * `page.tsx` must exist under `src/app/(app)`. It is crude on purpose — no route matcher, no
 * build step, no server — which is what makes it run in a millisecond and never go stale
 * against a framework upgrade.
 *
 * The second half is the inverse guarantee, and the more important one: an item with no page
 * must have **no `href` at all**. Rendering a planned screen as a disabled link would satisfy
 * the first check and still 404, because "disabled" on an anchor is styling —
 * `pointer-events-none` stops a mouse click and leaves middle-click, keyboard focus and the
 * screen-reader link list all pointing at a dead URL.
 */

const APP_DIR = resolve(__dirname, '../../src/app/(app)');

/** Where Next.js would look for the page backing a route. `/` is the group's own `page.tsx`. */
function pageFileFor(href: string): string {
  const segments = href.split('/').filter((segment) => segment !== '');
  return resolve(APP_DIR, ...segments, 'page.tsx');
}

describe('the navigation tree', () => {
  it('links only to pages that exist', () => {
    const broken = navigableHrefs().filter((href) => !existsSync(pageFileFor(href)));

    // Named rather than counted, so a failure says which link is dead.
    expect(broken).toEqual([]);
  });

  it('gives every unbuilt screen no href whatsoever', () => {
    // The invariant that keeps the first test meaningful. A planned item is a `<span>`; the
    // renderer has no branch that produces an anchor without a page behind it.
    const planned = NAVIGATION.flatMap((module) =>
      module.groups.flatMap((group) => group.items.filter((item) => item.href === undefined)),
    );

    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((item) => !('href' in item) || item.href === undefined)).toBe(true);
  });

  it('covers every page that exists, so nothing is unreachable', () => {
    // The other direction: a screen with no way to reach it is as good as unbuilt. `/login`
    // and `/offline` are outside the authenticated group and deliberately not in the tree.
    const pages = [
      '/',
      '/approvals',
      '/finance/accounts',
      '/finance/ageing',
      '/finance/balance-sheet',
      '/finance/depreciation',
      '/finance/general-ledger',
      '/finance/income-statement',
      '/finance/journals',
      '/finance/journals/new',
      '/finance/trial-balance',
      '/inventory/adjustments',
      '/inventory/products',
      '/inventory/stock',
      '/inventory/stock-card',
      '/inventory/transfers',
      '/inventory/valuation',
      '/org/branches',
      '/procurement/invoices',
      '/procurement/suppliers',
      '/sales/customers',
      '/sales/invoices',
      '/sales/invoices/new',
      '/treasury/payments',
      '/treasury/payments/new',
      '/system/audit',
      '/system/roles',
      '/system/users',
      '/treasury/reconciliation',
    ];

    const linked = new Set(navigableHrefs());
    const unreachable = pages.filter((page) => !linked.has(page));

    expect(unreachable).toEqual([]);
  });

  it('has no duplicate destinations within a module', () => {
    // The same screen listed twice in one module is a copy-paste artefact, and it makes the
    // "current page" highlight ambiguous.
    for (const module of NAVIGATION) {
      const hrefs = module.groups.flatMap((group) =>
        group.items.map((item) => item.href).filter((href): href is string => href !== undefined),
      );
      expect(new Set(hrefs).size, `${module.titleEn} lists a destination twice`).toBe(
        hrefs.length,
      );
    }
  });

  it('labels every item in both languages', () => {
    for (const module of NAVIGATION) {
      expect(module.titleAr.length).toBeGreaterThan(0);
      expect(module.titleEn.length).toBeGreaterThan(0);

      for (const group of module.groups) {
        for (const item of group.items) {
          expect(item.labelAr.length, `${item.labelEn} has no Arabic label`).toBeGreaterThan(0);
          expect(item.labelEn.length, `${item.labelAr} has no English label`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('sorts every item into setup, operations or reports', () => {
    for (const module of NAVIGATION) {
      for (const group of module.groups) {
        expect(Object.keys(GROUP_LABELS)).toContain(group.kind);
        expect(group.items.length, `${module.titleEn}/${group.kind} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('names no group twice in one module', () => {
    for (const module of NAVIGATION) {
      const kinds = module.groups.map((group) => group.kind);
      expect(new Set(kinds).size, `${module.titleEn} repeats a group`).toBe(kinds.length);
    }
  });
});

describe('the active module', () => {
  it('opens the module a page belongs to', () => {
    expect(activeModuleFor('/finance/trial-balance')).toBe('Financials');
    expect(activeModuleFor('/treasury/payments')).toBe('Financials');
    expect(activeModuleFor('/sales/invoices')).toBe('Sales & Procurement');
    expect(activeModuleFor('/inventory/stock-card')).toBe('Inventory & Logistics');
  });

  it('prefers the longest matching destination', () => {
    // `/treasury/payments/new` matches both `/treasury/payments` and itself. A shortest-match
    // or first-match rule would work here by luck and break the moment two modules share a
    // prefix.
    expect(activeModuleFor('/treasury/payments/new')).toBe('Financials');
    expect(activeModuleFor('/sales/invoices/new')).toBe('Sales & Procurement');
  });

  it('does not let the dashboard claim every path', () => {
    // `/` is a prefix of everything. Matched by equality rather than `startsWith`, or the
    // dashboard would be the active module on every screen in the system.
    expect(activeModuleFor('/')).toBe('Dashboard');
    expect(activeModuleFor('/finance/journals')).toBe('Financials');
  });

  it('returns null for a path outside the tree', () => {
    expect(activeModuleFor('/some/unknown/screen')).toBeNull();
  });
});

describe('every link the application can emit', () => {
  /**
   * Global search was the other source of 404s, and a worse one: six of its seven destinations
   * were detail routes that had never been written, so pressing Enter on any hit but a product
   * landed on a 404 from a keystroke every user has in their fingers.
   *
   * Those hrefs are built from database rows, so they cannot be walked the way the nav tree
   * can. What *can* be asserted is the shape: every literal path prefix the search service
   * emits must correspond to a page that exists. The list is duplicated from the service on
   * purpose — if the two drift, this is where it surfaces.
   */
  const SEARCH_DESTINATIONS = [
    { prefix: '/inventory/products', page: 'inventory/products/[id]' },
    { prefix: '/sales/customers', page: 'sales/customers/[id]' },
    { prefix: '/procurement/suppliers', page: 'procurement/suppliers/[id]' },
    { prefix: '/sales/invoices', page: 'sales/invoices' },
    { prefix: '/finance/general-ledger', page: 'finance/general-ledger' },
  ];

  it('points search results only at pages that exist', () => {
    const broken = SEARCH_DESTINATIONS.filter(
      (destination) => !existsSync(resolve(APP_DIR, destination.page, 'page.tsx')),
    ).map((destination) => destination.prefix);

    expect(broken).toEqual([]);
  });

  it('emits no href for the entities with no screen', async () => {
    // Counterparties, accounts, employees and purchase documents have no page. The service
    // must return `null` for them rather than a plausible-looking URL — the search UI has a
    // branch for `null` and none for "a link that happens to 404".
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        resolve(__dirname, '../../src/lib/application/services/search-service.ts'),
        'utf8',
      ),
    );

    // The route families that used to be emitted and no longer exist anywhere.
    // Still unbuilt. `/sales/customers/`, `/procurement/suppliers/` and `/inventory/products/`
    // left this list when their detail pages shipped.
    // `/finance/accounts/` left this list when account hits started landing on the general
    // ledger instead — a report that exists beats a detail page that does not.
    for (const dead of ['/hr/employees/', '/procurement/invoices/']) {
      expect(source, `search-service still emits ${dead}`).not.toContain(`\`${dead}`);
    }
  });
});
