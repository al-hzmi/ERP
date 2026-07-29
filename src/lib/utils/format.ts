/**
 * Presentation formatting.
 *
 * Two things here are specific to an Arabic-first system and are the usual
 * source of subtle bugs:
 *
 *  1. **Numerals.** Arabic-Indic digits (١٢٣) and Western digits (123) are both
 *     correct Arabic; which one to show is a user preference, not a locale fact.
 *  2. **Bidirectional text.** A Latin document number inside an Arabic sentence
 *     is reordered by the Unicode bidi algorithm unless it is explicitly
 *     isolated, so `INV-2026-00001` renders as `00001-2026-INV`.
 *
 * Amounts arrive as decimal strings and are formatted as strings. They are never
 * parsed into a `number` on the way to the screen — a value that survived the
 * whole system exactly should not lose precision in its last three metres.
 */

export type NumeralSystem = 'western' | 'arabic-indic';
export type Locale = 'ar' | 'en';
export type CalendarPreference = 'gregorian' | 'hijri' | 'both';

const ARABIC_INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/** Converts Western digits to Arabic-Indic, leaving everything else alone. */
export function toArabicIndic(value: string): string {
  return value.replace(/[0-9]/g, (digit) => ARABIC_INDIC_DIGITS[Number(digit)] ?? digit);
}

/** Converts Arabic-Indic digits back to Western — for parsing user input. */
export function toWesternDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC_DIGITS.indexOf(digit as never)));
}

export interface MoneyFormatOptions {
  readonly currency?: string;
  readonly locale?: Locale;
  readonly numerals?: NumeralSystem;
  readonly decimals?: number;
  /** Show the currency code/symbol. Off inside a column that already has a header. */
  readonly showCurrency?: boolean;
  /** Render 1,250,000 as "1.25 M". For dashboard tiles, never for a ledger. */
  readonly compact?: boolean;
}

const CURRENCY_SYMBOLS: Record<string, { ar: string; en: string }> = {
  SAR: { ar: 'ر.س', en: 'SAR' },
  USD: { ar: '$', en: '$' },
  EUR: { ar: '€', en: '€' },
  AED: { ar: 'د.إ', en: 'AED' },
  KWD: { ar: 'د.ك', en: 'KWD' },
};

/**
 * Formats a decimal string as a monetary amount with thousands separators.
 *
 * Grouping is applied by string manipulation rather than `Intl.NumberFormat`,
 * because the latter takes a `number` and would round 999,999,999,999.9999 on
 * the way in.
 */
export function formatMoney(amount: string, options: MoneyFormatOptions = {}): string {
  const locale = options.locale ?? 'ar';
  const decimals = options.decimals ?? 2;
  const numerals = options.numerals ?? 'western';

  const negative = amount.trimStart().startsWith('-');
  const absolute = negative ? amount.trim().slice(1) : amount.trim();

  const [integerPart = '0', fractionPart = ''] = absolute.split('.');

  if (options.compact === true) {
    return formatCompact(negative, integerPart, options);
  }

  const rounded = roundFractionString(integerPart, fractionPart, decimals);
  const grouped = groupThousands(rounded.integerPart);

  let formatted = decimals > 0 ? `${grouped}.${rounded.fractionPart}` : grouped;
  if (negative) formatted = `-${formatted}`;
  if (numerals === 'arabic-indic') formatted = toArabicIndic(formatted);

  if (options.showCurrency === false || options.currency === undefined) {
    return formatted;
  }

  const symbol = CURRENCY_SYMBOLS[options.currency] ?? { ar: options.currency, en: options.currency };
  return locale === 'ar' ? `${formatted} ${symbol.ar}` : `${symbol.en} ${formatted}`;
}

/**
 * Rounds a decimal held as two strings, carrying into the integer part.
 *
 * Doing this on the string keeps arbitrary precision: `parseFloat` would quietly
 * cap us at 15 significant digits, which a large ledger exceeds.
 */
function roundFractionString(
  integerPart: string,
  fractionPart: string,
  decimals: number,
): { integerPart: string; fractionPart: string } {
  if (fractionPart.length <= decimals) {
    return { integerPart, fractionPart: fractionPart.padEnd(decimals, '0') };
  }

  const kept = fractionPart.slice(0, decimals);
  const nextDigit = Number(fractionPart[decimals] ?? '0');

  if (nextDigit < 5) {
    return { integerPart, fractionPart: kept };
  }

  // Round half up, propagating the carry through the fraction and then the
  // integer part digit by digit.
  const digits = `${integerPart}${kept}`.split('');
  let index = digits.length - 1;
  let carry = 1;

  while (index >= 0 && carry === 1) {
    const value = Number(digits[index] ?? '0') + carry;
    digits[index] = String(value % 10);
    carry = value >= 10 ? 1 : 0;
    index -= 1;
  }

  const carried = carry === 1 ? ['1', ...digits] : digits;
  const joined = carried.join('');
  const splitAt = joined.length - decimals;

  return {
    integerPart: joined.slice(0, splitAt) || '0',
    fractionPart: joined.slice(splitAt),
  };
}

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const COMPACT_UNITS: readonly { threshold: number; ar: string; en: string }[] = [
  { threshold: 12, ar: 'ت', en: 'T' },
  { threshold: 9, ar: 'مليار', en: 'B' },
  { threshold: 6, ar: 'مليون', en: 'M' },
  { threshold: 3, ar: 'ألف', en: 'K' },
];

function formatCompact(
  negative: boolean,
  integerPart: string,
  options: MoneyFormatOptions,
): string {
  const locale = options.locale ?? 'ar';
  const digits = integerPart.length;

  const unit = COMPACT_UNITS.find((candidate) => digits > candidate.threshold);

  if (unit === undefined) {
    const grouped = groupThousands(integerPart);
    const value = negative ? `-${grouped}` : grouped;
    return options.numerals === 'arabic-indic' ? toArabicIndic(value) : value;
  }

  const whole = integerPart.slice(0, digits - unit.threshold);
  const remainder = integerPart.slice(digits - unit.threshold, digits - unit.threshold + 1);
  const label = locale === 'ar' ? unit.ar : unit.en;

  const value = `${negative ? '-' : ''}${whole}.${remainder} ${label}`;
  return options.numerals === 'arabic-indic' ? toArabicIndic(value) : value;
}

/** Formats a quantity: no currency, and trailing zeros trimmed. */
export function formatQuantity(
  quantity: string,
  options: { numerals?: NumeralSystem; maxDecimals?: number } = {},
): string {
  const maxDecimals = options.maxDecimals ?? 4;
  const [integerPart = '0', fractionPart = ''] = quantity.split('.');

  const trimmed = fractionPart.slice(0, maxDecimals).replace(/0+$/, '');
  const value = trimmed === ''
    ? groupThousands(integerPart)
    : `${groupThousands(integerPart)}.${trimmed}`;

  return options.numerals === 'arabic-indic' ? toArabicIndic(value) : value;
}

/** Formats a percentage from a decimal string. */
export function formatPercent(
  value: string,
  options: { numerals?: NumeralSystem; decimals?: number } = {},
): string {
  const formatted = formatMoney(value, {
    decimals: options.decimals ?? 1,
    showCurrency: false,
    ...(options.numerals !== undefined ? { numerals: options.numerals } : {}),
  });
  return `${formatted}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a date in the Gregorian calendar, the Hijri (Umm al-Qura) calendar, or
 * both.
 *
 * The Hijri conversion uses the platform's `islamic-umalqura` calendar rather
 * than an arithmetic approximation — the arithmetic ones drift by a day against
 * the Saudi civil calendar, which matters when it decides an invoice's period.
 */
export function formatDate(
  date: Date | string,
  options: {
    locale?: Locale;
    calendar?: CalendarPreference;
    numerals?: NumeralSystem;
    style?: 'short' | 'medium' | 'long';
  } = {},
): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return '—';

  const locale = options.locale ?? 'ar';
  const calendar = options.calendar ?? 'gregorian';
  const style = options.style ?? 'medium';

  const gregorian = formatWithCalendar(value, locale, 'gregory', style);

  if (calendar === 'gregorian') {
    return applyNumerals(gregorian, options.numerals);
  }

  const hijri = formatWithCalendar(value, locale, 'islamic-umalqura', style);

  if (calendar === 'hijri') {
    return applyNumerals(hijri, options.numerals);
  }

  return applyNumerals(`${hijri} — ${gregorian}`, options.numerals);
}

function formatWithCalendar(
  date: Date,
  locale: Locale,
  calendar: string,
  style: 'short' | 'medium' | 'long',
): string {
  try {
    return new Intl.DateTimeFormat(`${locale}-SA-u-ca-${calendar}-nu-latn`, {
      dateStyle: style,
      timeZone: 'UTC',
    }).format(date);
  } catch {
    // A runtime without full ICU cannot do Umm al-Qura; degrade to ISO rather
    // than showing a wrong date confidently.
    return date.toISOString().slice(0, 10);
  }
}

function applyNumerals(value: string, numerals: NumeralSystem | undefined): string {
  return numerals === 'arabic-indic' ? toArabicIndic(value) : value;
}

/** Relative time ("since 3 days"), for audit trails and activity feeds. */
export function formatRelativeTime(date: Date | string, locale: Locale = 'ar'): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return '—';

  const deltaSeconds = Math.round((value.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);

  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  for (const [unit, seconds] of units) {
    if (absolute >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }

  return formatter.format(deltaSeconds, 'second');
}

/**
 * Wraps a Latin identifier so the bidi algorithm cannot reorder it inside
 * Arabic text. Returns the props for a span rather than markup, so it composes
 * with whatever component needs it.
 */
export function bidiIsolate(value: string): { children: string; dir: 'ltr'; className: string } {
  return { children: value, dir: 'ltr', className: 'bidi-isolate' };
}

/** Localised label for a document or journal status. */
export function statusLabel(
  status: string,
  locale: Locale = 'ar',
): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' } {
  const map: Record<string, { ar: string; en: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
    DRAFT: { ar: 'مسودة', en: 'Draft', tone: 'neutral' },
    PENDING_APPROVAL: { ar: 'بانتظار الاعتماد', en: 'Pending approval', tone: 'warning' },
    POSTED: { ar: 'مرحّل', en: 'Posted', tone: 'info' },
    PARTIAL_PAID: { ar: 'مسدد جزئياً', en: 'Partially paid', tone: 'warning' },
    FULLY_PAID: { ar: 'مسدد بالكامل', en: 'Fully paid', tone: 'success' },
    VOID: { ar: 'ملغى', en: 'Void', tone: 'danger' },
    RETURNED: { ar: 'مرتجع', en: 'Returned', tone: 'danger' },
    REVERSED: { ar: 'معكوس', en: 'Reversed', tone: 'danger' },
  };

  const entry = map[status];
  if (entry === undefined) return { label: status, tone: 'neutral' };
  return { label: locale === 'ar' ? entry.ar : entry.en, tone: entry.tone };
}
