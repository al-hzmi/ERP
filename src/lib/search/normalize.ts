/**
 * Search-term normalisation.
 *
 * Every rule here exists because a query that a user would reasonably type returned nothing
 * against the seeded database. They were measured, not guessed:
 *
 * | typed | matches without this | with it |
 * |---|---|---|
 * | `١٠٣٨` (Arabic-Indic) | 0 | `BTC-1038` |
 * | `BTC1038` (no separator) | 0 | `BTC-1038` |
 * | `الصفوه` (ه for ة) | 0 | 16 counterparties |
 * | `الافق` (no hamza) | 0 | 12 counterparties |
 *
 * The first is the sharpest, and it is self-inflicted: `formatMoney` and `formatQuantity`
 * render digits in Arabic-Indic, so the application prints codes its own search could not
 * find. A user reading `BTC-١٠٣٨` off the screen and typing it back got an empty list.
 *
 * ## What is deliberately *not* normalised
 *
 * **`ء` is left alone.** Collapsing it into `ا` merges words that are genuinely different, and
 * unlike the hamza-carrier forms it is not a spelling anyone varies by accident.
 *
 * **Case is folded only for Latin.** Arabic has no case, and `toLowerCase` on Arabic text is a
 * no-op that costs a pass.
 *
 * ## This file has a twin in SQL and they must not drift
 *
 * `erp_normalize_search()` (migration 012) applies the same rules inside PostgreSQL, because
 * the comparison happens there. Two implementations of one rule set is a drift risk, so
 * `tests/integration/search-normalisation.test.ts` runs the table below through *both* and
 * asserts they agree character for character. Changing one without the other fails that test.
 */

/** `٠..٩` (U+0660) and `۰..۹` (U+06F0), the two Arabic-Indic digit blocks in use. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/** Harakat, tanwin, shadda, sukun — and the tatweel that only stretches a glyph. */
const ARABIC_DIACRITICS = /[ً-ْٰـ]/g;

/**
 * Folds a term to the form both sides compare on.
 *
 * Order matters: diacritics are stripped before letters are folded, so a hamza carrying a
 * fatha normalises the same as a bare one.
 */
export function normalizeSearchTerm(input: string): string {
  return input
    .replace(ARABIC_INDIC_DIGITS, (digit) => {
      const code = digit.charCodeAt(0);
      // Both blocks are contiguous and ordered 0-9, so the offset from the block's zero is
      // the digit itself.
      const zero = code >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(code - zero);
    })
    .replace(ARABIC_DIACRITICS, '')
    // Hamza carriers → bare alif. `أحمد` and `احمد` are the same name typed by two people.
    .replace(/[أإآٱ]/g, 'ا')
    // Ta marbuta → ha. `الصفوة` / `الصفوه`.
    .replace(/ة/g, 'ه')
    // Alif maqsura → ya. `مستشفى` / `مستشفي`.
    .replace(/ى/g, 'ي')
    // Waw and ya with hamza → their carriers.
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    // Farsi keyboard forms that land in Arabic text and look identical.
    .replace(/ک/g, 'ك')
    .replace(/ی/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The form a *code* is compared on: normalised, then stripped of everything that is not a
 * letter or a digit.
 *
 * This is what lets `BTC1038`, `btc-1038` and `BTC 1038` all reach `BTC-1038`. Separators in
 * a code are a house style; nobody types them reliably, and requiring them makes the system
 * fussier than the person using it.
 *
 * Kept apart from `normalizeSearchTerm` rather than folded into it, because stripping
 * punctuation from a *name* would join words: `شركة الصفوة` would become one token and stop
 * matching either half.
 */
export function compactCode(input: string): string {
  return normalizeSearchTerm(input).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Splits a query into the terms that must all match, in any column.
 *
 * `صفوة خدمات` finds `شركة الصفوة للخدمات`, which a single `ILIKE '%صفوة خدمات%'` cannot: the
 * words are separated by text the user did not type. Each token is required — narrowing as you
 * add words is what people expect from a search box — but they may land in different columns.
 *
 * Capped at six because the tokens become one SQL condition each, and a query longer than six
 * words is not a search, it is a paste.
 */
export function tokenize(input: string): string[] {
  const normalized = normalizeSearchTerm(input);
  if (normalized === '') return [];
  return normalized.split(' ').filter((token) => token !== '').slice(0, 6);
}
