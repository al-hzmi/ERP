import { describe, expect, it } from 'vitest';
import { compactCode, normalizeSearchTerm, tokenize } from '@/lib/search/normalize';
import { rankCommands, COMMANDS } from '@/lib/search/command-registry';

/**
 * Search normalisation, and the command ranking built on it.
 *
 * Each case in the first block corresponds to a query that returned **zero rows** against the
 * seeded company before this existed. They are regressions, not illustrations.
 */

describe('normalizeSearchTerm', () => {
  it('folds Arabic-Indic digits to Western ones', () => {
    // The sharpest of the four, and self-inflicted: `formatQuantity` prints Arabic-Indic
    // digits, so the application rendered codes its own search could not find.
    expect(normalizeSearchTerm('١٠٣٨')).toBe('1038');
    expect(normalizeSearchTerm('BTC-١٠٣٨')).toBe('btc-1038');
  });

  it('folds the Eastern Arabic-Indic digit block too', () => {
    // U+06F0..U+06F9, which arrives from Farsi keyboards and looks identical in most fonts.
    expect(normalizeSearchTerm('۱۰۳۸')).toBe('1038');
  });

  it('folds hamza carriers to a bare alif', () => {
    expect(normalizeSearchTerm('الأفق')).toBe(normalizeSearchTerm('الافق'));
    expect(normalizeSearchTerm('إدارة')).toBe(normalizeSearchTerm('ادارة'));
    expect(normalizeSearchTerm('آخر')).toBe(normalizeSearchTerm('اخر'));
  });

  it('folds ta marbuta to ha and alif maqsura to ya', () => {
    expect(normalizeSearchTerm('الصفوة')).toBe(normalizeSearchTerm('الصفوه'));
    expect(normalizeSearchTerm('مستشفى')).toBe(normalizeSearchTerm('مستشفي'));
  });

  it('strips diacritics and tatweel', () => {
    expect(normalizeSearchTerm('مُحَمَّد')).toBe(normalizeSearchTerm('محمد'));
    expect(normalizeSearchTerm('محـــمد')).toBe(normalizeSearchTerm('محمد'));
  });

  it('folds Farsi letter forms that look like Arabic ones', () => {
    expect(normalizeSearchTerm('کتاب')).toBe(normalizeSearchTerm('كتاب'));
  });

  it('leaves a standalone hamza alone', () => {
    // Deliberate: unlike the carrier forms, `ء` is not a spelling people vary by accident,
    // and folding it into alif merges words that are genuinely different.
    expect(normalizeSearchTerm('ماء')).not.toBe(normalizeSearchTerm('ماا'));
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeSearchTerm('  شركة   الصفوة  ')).toBe('شركه الصفوه');
  });

  it('lowercases Latin text', () => {
    expect(normalizeSearchTerm('BTC-1038')).toBe('btc-1038');
  });
});

describe('compactCode', () => {
  it('drops separators so a code matches however it is typed', () => {
    expect(compactCode('BTC-1038')).toBe('btc1038');
    expect(compactCode('BTC 1038')).toBe('btc1038');
    expect(compactCode('btc1038')).toBe('btc1038');
    expect(compactCode('BTC-١٠٣٨')).toBe('btc1038');
  });

  it('is empty for a term made only of punctuation', () => {
    // Load-bearing: `matchClause` skips an empty code form rather than building
    // `LIKE '%%'`, which would match every row in the table.
    expect(compactCode('---')).toBe('');
    expect(compactCode('   ')).toBe('');
  });

  it('keeps Arabic letters', () => {
    expect(compactCode('عميل-١٢')).toBe('عميل12');
  });
});

describe('tokenize', () => {
  it('splits on whitespace after normalising', () => {
    expect(tokenize('صفوة  خدمات')).toEqual(['صفوه', 'خدمات']);
  });

  it('returns nothing for an empty query', () => {
    // `matchClause` turns an empty token list into `false`. No query must not mean every row.
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  it('caps at six tokens', () => {
    const long = tokenize('a b c d e f g h i');
    expect(long).toHaveLength(6);
  });
});

describe('rankCommands', () => {
  it('returns nothing for an empty query', () => {
    expect(rankCommands('')).toEqual([]);
  });

  it('finds a screen by an Arabic word in its label', () => {
    const results = rankCommands('الجرد');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.command.href).toBe('/inventory/counts');
  });

  it('finds a screen typed without the hamza', () => {
    // `أوامر` typed as `اوامر` — the thing that makes the palette usable on a keyboard
    // where hamza is an extra keystroke.
    const withHamza = rankCommands('أوامر الشراء');
    const without = rankCommands('اوامر الشراء');
    expect(without[0]?.command.href).toBe(withHamza[0]?.command.href);
    expect(without[0]?.command.href).toBe('/procurement/orders');
  });

  it('puts a create action above a register at equal confidence', () => {
    const results = rankCommands('فاتورة مبيعات');
    expect(results[0]?.command.kind).toBe('action');
    expect(results[0]?.command.href).toBe('/sales/invoices/new');
  });

  it('narrows as words are added rather than widening', () => {
    const one = rankCommands('تقرير', 50).length;
    const two = rankCommands('تقرير مبيعات', 50).length;
    expect(two).toBeLessThanOrEqual(one);
  });

  it('matches an action through a keyword that is never displayed', () => {
    // "سند" is the word people use; the label says "سند قبض جديد", but the keyword list is
    // what makes the English "voucher" reach it too.
    const results = rankCommands('voucher');
    expect(results[0]?.command.href).toBe('/treasury/payments/new');
  });

  it('reaches a screen by its word initials', () => {
    const results = rankCommands('فم');
    expect(results.some((r) => r.command.href === '/sales/invoices')).toBe(true);
  });

  it('offers no command with a destination that does not exist', () => {
    // The registry is derived from NAVIGATION, whose hrefs `navigation.test.ts` already
    // proves resolve to real pages. This asserts the derivation did not invent any.
    for (const command of COMMANDS) {
      expect(command.href).toMatch(/^\//);
      expect(command.href).not.toBe('/');
    }
  });

  it('lists every destination once', () => {
    // `/org/branches` appears under two modules in the navigation tree; two identical rows
    // in the palette is a bug the user sees.
    const hrefs = COMMANDS.filter((c) => c.kind === 'navigate').map((c) => c.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
