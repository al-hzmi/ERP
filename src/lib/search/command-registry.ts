import type { LucideIcon } from 'lucide-react';
import { BookPlus, FilePlus2, PackagePlus, Receipt, Wallet } from 'lucide-react';
import { NAVIGATION, GROUP_LABELS } from '@/lib/navigation';
import { compactCode, normalizeSearchTerm, tokenize } from './normalize';

/**
 * The static half of the command palette: things you can *do* and screens you can go to.
 *
 * Derived from `NAVIGATION` rather than listed again, which is the whole reason this is a
 * module and not an array inside the component. `tests/unit/navigation.test.ts` already
 * asserts every `href` in that tree resolves to a real `page.tsx`; deriving from it means the
 * palette inherits that guarantee instead of needing its own copy of it — and an unbuilt
 * screen, which carries no `href`, simply never becomes a destination.
 */

export type CommandKind = 'action' | 'navigate';

export interface Command {
  readonly id: string;
  readonly kind: CommandKind;
  readonly labelAr: string;
  readonly labelEn: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** The module this belongs to, shown as the row's trailing context. */
  readonly groupAr: string;
  /** Extra words that should match this command without being displayed. */
  readonly keywords?: readonly string[];
}

/**
 * The create actions, above everything else.
 *
 * Only the five entry screens that actually exist. A "new purchase invoice" action would be
 * the palette's own version of the 404 the navigation tree was built to prevent — purchase
 * invoice entry is API-only.
 */
const ACTIONS: readonly Command[] = [
  {
    id: 'action:sales-invoice',
    kind: 'action',
    labelAr: 'فاتورة مبيعات جديدة',
    labelEn: 'New sales invoice',
    href: '/sales/invoices/new',
    icon: FilePlus2,
    groupAr: 'إنشاء',
    keywords: ['بيع', 'فاتوره', 'invoice', 'sale', 'sell'],
  },
  {
    id: 'action:sales-order',
    kind: 'action',
    labelAr: 'أمر بيع جديد',
    labelEn: 'New sales order',
    href: '/sales/orders',
    icon: Receipt,
    groupAr: 'إنشاء',
    keywords: ['طلب', 'اوردر', 'order', 'so'],
  },
  {
    id: 'action:receipt-voucher',
    kind: 'action',
    labelAr: 'سند قبض جديد',
    labelEn: 'New receipt voucher',
    href: '/treasury/payments/new',
    icon: Wallet,
    groupAr: 'إنشاء',
    keywords: ['قبض', 'صرف', 'سند', 'voucher', 'receipt', 'payment'],
  },
  {
    id: 'action:journal',
    kind: 'action',
    labelAr: 'قيد محاسبي جديد',
    labelEn: 'New journal entry',
    href: '/finance/journals/new',
    icon: BookPlus,
    groupAr: 'إنشاء',
    keywords: ['قيد', 'يومية', 'journal', 'je'],
  },
  {
    id: 'action:stock-count',
    kind: 'action',
    labelAr: 'ورقة جرد جديدة',
    labelEn: 'New stock count',
    href: '/inventory/counts',
    icon: PackagePlus,
    groupAr: 'إنشاء',
    keywords: ['جرد', 'count', 'stocktake'],
  },
];

/**
 * Every navigable screen, flattened out of the navigation tree.
 *
 * The dashboard is skipped: `/` is one keystroke away by other means and listing it puts a
 * row nobody wants at the top of an empty palette.
 */
function navigationCommands(): Command[] {
  const commands: Command[] = [];
  const seen = new Set<string>();

  for (const module of NAVIGATION) {
    for (const group of module.groups) {
      for (const item of group.items) {
        if (item.href === undefined || item.href === '/') continue;
        // `/org/branches` appears under two modules. One row, filed under the first.
        if (seen.has(item.href)) continue;
        seen.add(item.href);

        commands.push({
          id: `nav:${item.href}`,
          kind: 'navigate',
          labelAr: item.labelAr,
          labelEn: item.labelEn,
          href: item.href,
          icon: item.icon,
          groupAr: `${module.titleAr} · ${GROUP_LABELS[group.kind].ar}`,
        });
      }
    }
  }

  return commands;
}

export const COMMANDS: readonly Command[] = [...ACTIONS, ...navigationCommands()];

export interface ScoredCommand {
  readonly command: Command;
  readonly score: number;
}

/**
 * Ranks commands against what has been typed.
 *
 * Uses the same `normalize.ts` the server search uses, so the palette answers `الجرد` and
 * `الجرد` typed with a different alif identically — and typing Arabic-Indic digits works here
 * too, for the screens whose names carry numbers.
 *
 * Every token must match, matching the server's rule. A user who has learned that adding a
 * word narrows the list should not find that the two halves of one palette disagree about it.
 *
 * ## The ladder
 *
 * Prefix beats substring beats initials. The initials rung is what makes `فم` reach
 * "فواتير المبيعات" — cheap to compute and the thing that makes a palette feel fast to
 * somebody who uses it every day.
 */
export function rankCommands(query: string, limit = 8): ScoredCommand[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: ScoredCommand[] = [];

  for (const command of COMMANDS) {
    const haystacks = [
      normalizeSearchTerm(command.labelAr),
      normalizeSearchTerm(command.labelEn),
      normalizeSearchTerm(command.groupAr),
      ...(command.keywords ?? []).map(normalizeSearchTerm),
    ];

    const initials = wordInitials(command.labelAr);
    const initialsEn = wordInitials(command.labelEn);

    let total = 0;
    let matchedEvery = true;

    for (const token of tokens) {
      let best = 0;

      for (const [index, haystack] of haystacks.entries()) {
        // The Arabic label is what the user is looking at, so it outranks the English one
        // and the hidden keywords by a small margin rather than a decisive one.
        const weight = index === 0 ? 1 : index === 1 ? 0.95 : 0.85;

        if (haystack === token) best = Math.max(best, 1 * weight);
        else if (haystack.startsWith(token)) best = Math.max(best, 0.9 * weight);
        else if (haystack.includes(` ${token}`)) best = Math.max(best, 0.82 * weight);
        else if (haystack.includes(token)) best = Math.max(best, 0.7 * weight);
      }

      const compact = compactCode(token);
      if (best === 0 && compact !== '') {
        if (initials.startsWith(compact) || initialsEn.startsWith(compact)) best = 0.75;
      }

      if (best === 0) {
        matchedEvery = false;
        break;
      }

      total += best;
    }

    if (!matchedEvery) continue;

    // Averaged, so a two-word query that matches both words beats one that matches one word
    // twice as strongly.
    scored.push({ command, score: total / tokens.length });
  }

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Actions before navigation at equal confidence: someone who typed enough to tie them
      // is more likely to be creating something than looking at a register.
      if (a.command.kind !== b.command.kind) return a.command.kind === 'action' ? -1 : 1;
      return a.command.labelAr.localeCompare(b.command.labelAr, 'ar');
    })
    .slice(0, limit);
}

/**
 * First letter of each word, normalised — so `فم` reaches "فواتير المبيعات".
 *
 * The definite article is stripped first, and that is not a nicety: without it the initials
 * of "فواتير المبيعات" are `فا`, because `المبيعات` begins with the alif of `ال`. Every
 * Arabic label in this system is full of definite articles, so naive initials would spell
 * out the article rather than the words and the feature would match almost nothing.
 *
 * A two-letter word that is only `ال` keeps its alif rather than becoming empty — dropping it
 * would silently shorten the initials and shift every letter after it.
 */
function wordInitials(label: string): string {
  return normalizeSearchTerm(label)
    .split(' ')
    .map((word) => (word.length > 2 && word.startsWith('ال') ? word.slice(2) : word))
    .map((word) => word.charAt(0))
    .join('');
}
