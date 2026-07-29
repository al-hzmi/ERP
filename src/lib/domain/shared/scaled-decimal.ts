/**
 * Fixed-point decimal arithmetic on `bigint`.
 *
 * Every monetary and quantity value in this system is an integer count of
 * 1/10,000 units ("scale 4"). `bigint` is arbitrary precision, so 999,999,999,999.9999
 * — and any product of it — is exact. No IEEE-754 anywhere on the money path.
 *
 * Why scale 4 rather than 2 (halalas):
 *   - Unit prices are quoted to 4 decimals in wholesale and utilities.
 *   - Intermediate products (qty x price x rate) keep their precision until the
 *     single, explicit rounding step at the end of a calculation.
 *   - It matches the DECIMAL(19,4) column type exactly, so a value round-trips
 *     through PostgreSQL without loss.
 */

/** Number of decimal digits retained internally. */
export const SCALE = 4;

/** 10 ** SCALE — the multiplier between a display value and its internal integer. */
export const SCALE_FACTOR = 10_000n;

/**
 * Rounding strategies. HALF_UP is the default because it is what ZATCA, IFRS
 * illustrative examples and every accountant's spreadsheet do. HALF_EVEN
 * (banker's rounding) is offered for statistical allocations where repeated
 * HALF_UP would introduce a systematic upward bias.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

const MAX_SAFE_SCALED = 9_999_999_999_999_9999n; // 999,999,999,999.9999 at scale 4

/** Thrown for malformed numeric input before it can contaminate a calculation. */
export class DecimalParseError extends Error {
  constructor(
    public readonly input: string,
    reason: string,
  ) {
    super(`Cannot parse "${input}" as a decimal: ${reason}`);
    this.name = 'DecimalParseError';
  }
}

/** Thrown when a value exceeds the DECIMAL(19,4) domain the database can store. */
export class DecimalOverflowError extends Error {
  constructor(public readonly value: bigint) {
    super(`Value ${value} exceeds the supported range of DECIMAL(19,4).`);
    this.name = 'DecimalOverflowError';
  }
}

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Parses a decimal string into a scale-4 integer.
 *
 * Accepts an optional sign, an optional integer part and an optional fraction.
 * Digits beyond scale 4 are rejected rather than silently truncated — losing a
 * digit quietly is how rounding bugs are born.
 */
export function parseScaled(input: string | number | bigint): bigint {
  if (typeof input === 'bigint') {
    return guardRange(input * SCALE_FACTOR);
  }

  const raw = typeof input === 'number' ? numberToString(input) : input.trim();

  if (raw === '' || raw === '+' || raw === '-') {
    throw new DecimalParseError(raw, 'the value is empty');
  }

  const match = DECIMAL_PATTERN.exec(raw);
  if (match === null) {
    throw new DecimalParseError(raw, 'it is not a plain decimal number');
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const integerPart = match[2] ?? '';
  const fractionPart = match[3] ?? '';

  if (integerPart === '' && fractionPart === '') {
    throw new DecimalParseError(raw, 'it contains no digits');
  }

  if (fractionPart.length > SCALE) {
    // Trailing zeros beyond the scale are harmless; real precision is not.
    const excess = fractionPart.slice(SCALE);
    if (/[^0]/.test(excess)) {
      throw new DecimalParseError(
        raw,
        `it carries more than ${SCALE} decimal places, which would silently lose precision`,
      );
    }
  }

  const normalisedFraction = fractionPart.slice(0, SCALE).padEnd(SCALE, '0');
  const magnitude = BigInt(`${integerPart === '' ? '0' : integerPart}${normalisedFraction}`);

  return guardRange(sign * magnitude);
}

/**
 * `number` is only ever an input format (a JSON body, a form field). Converting
 * through the shortest round-trip representation avoids importing 0.1 + 0.2
 * artefacts into the ledger.
 */
function numberToString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new DecimalParseError(String(value), 'it is not a finite number');
  }
  // toFixed(SCALE) is exact enough here: any double that survives JSON transport
  // and is destined for a DECIMAL(19,4) column has at most 4 meaningful decimals.
  return value.toFixed(SCALE);
}

function guardRange(scaled: bigint): bigint {
  if (scaled > MAX_SAFE_SCALED || scaled < -MAX_SAFE_SCALED) {
    throw new DecimalOverflowError(scaled);
  }
  return scaled;
}

/** Renders a scale-4 integer as a plain decimal string with `decimals` places. */
export function formatScaled(scaled: bigint, decimals: number = SCALE): string {
  if (decimals < 0 || decimals > SCALE) {
    throw new RangeError(`decimals must be between 0 and ${SCALE}, received ${decimals}`);
  }

  const rounded = decimals === SCALE ? scaled : rescale(scaled, decimals);
  const negative = rounded < 0n;
  const digits = (negative ? -rounded : rounded).toString().padStart(SCALE + 1, '0');

  const integerPart = digits.slice(0, digits.length - SCALE);
  const fractionPart = digits.slice(digits.length - SCALE, digits.length - SCALE + decimals);

  const body = decimals === 0 ? integerPart : `${integerPart}.${fractionPart}`;
  return negative ? `-${body}` : body;
}

/** Rounds a scale-4 integer to `decimals` places, keeping the scale-4 representation. */
export function rescale(
  scaled: bigint,
  decimals: number,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  if (decimals >= SCALE) return scaled;
  const divisor = 10n ** BigInt(SCALE - decimals);
  return divideRounded(scaled, divisor, mode) * divisor;
}

/**
 * Integer division with an explicit rounding policy.
 *
 * JavaScript's `/` on bigint truncates toward zero, which is a rounding decision
 * made by accident. Every rounding decision in this system is made on purpose.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  if (remainder === 0n) {
    return negative ? -quotient : quotient;
  }

  let adjusted: bigint;
  switch (mode) {
    case 'DOWN':
      adjusted = quotient;
      break;
    case 'UP':
      adjusted = quotient + 1n;
      break;
    case 'HALF_EVEN': {
      const doubled = remainder * 2n;
      if (doubled > absDenominator) adjusted = quotient + 1n;
      else if (doubled < absDenominator) adjusted = quotient;
      else adjusted = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
    case 'HALF_UP':
    default: {
      const doubled = remainder * 2n;
      adjusted = doubled >= absDenominator ? quotient + 1n : quotient;
      break;
    }
  }

  return negative ? -adjusted : adjusted;
}

/**
 * Multiplies two scale-4 integers, returning a scale-4 integer.
 *
 * The intermediate product is scale 8 and is held exactly in a bigint before the
 * single rounding step — so `qty x price` never accumulates error.
 */
export function multiplyScaled(a: bigint, b: bigint, mode: RoundingMode = 'HALF_UP'): bigint {
  return guardRange(divideRounded(a * b, SCALE_FACTOR, mode));
}

/** Divides two scale-4 integers, returning a scale-4 integer. */
export function divideScaled(a: bigint, b: bigint, mode: RoundingMode = 'HALF_UP'): bigint {
  if (b === 0n) {
    throw new RangeError('Division by zero');
  }
  return guardRange(divideRounded(a * SCALE_FACTOR, b, mode));
}

/**
 * Splits `total` across `weights` so that the parts sum *exactly* to the total.
 *
 * The naive approach — rounding each share independently — loses or invents
 * halalas, which is how an invoice ends up one halala away from balancing. Here
 * every share is floored, then the remaining units are handed out one at a time
 * to the shares with the largest discarded fraction (largest-remainder method).
 */
export function allocateScaled(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new RangeError('Cannot allocate across an empty set of weights');
  }

  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);

  if (weightSum === 0n) {
    // Degenerate case: no weights to go by, so spread as evenly as possible.
    const base = total / BigInt(weights.length);
    const shares = weights.map(() => base);
    let remainder = total - base * BigInt(weights.length);
    const step = remainder < 0n ? -1n : 1n;
    for (let i = 0; remainder !== 0n; i = (i + 1) % shares.length) {
      shares[i] = (shares[i] ?? 0n) + step;
      remainder -= step;
    }
    return shares;
  }

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0n;
    const exactNumerator = total * weight;
    const share = exactNumerator / weightSum; // truncates toward zero
    const remainder = exactNumerator - share * weightSum;
    shares.push(share);
    remainders.push({ index, remainder });
    distributed += share;
  }

  let leftover = total - distributed;
  const step = leftover < 0n ? -1n : 1n;

  // Largest remainder first; ties broken by index so allocation is deterministic.
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  let cursor = 0;
  while (leftover !== 0n) {
    const target = remainders[cursor % remainders.length];
    if (target === undefined) break;
    shares[target.index] = (shares[target.index] ?? 0n) + step;
    leftover -= step;
    cursor += 1;
  }

  return shares;
}

/** Absolute value of a scale-4 integer. */
export function absScaled(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exchange rates — scale 6
//
//  Rates need more precision than amounts: JPY/SAR is 0.025431, and rounding
//  that to four places moves a million-yen invoice by several riyals. They are
//  stored as DECIMAL(19,6) and handled here at a matching scale, rather than
//  being squeezed through the scale-4 path, which would reject a perfectly
//  legitimate six-decimal rate outright.
// ─────────────────────────────────────────────────────────────────────────────

/** Decimal digits retained for an exchange rate. */
export const RATE_SCALE = 6;

/** 10 ** RATE_SCALE. */
export const RATE_FACTOR = 1_000_000n;

const RATE_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Parses an exchange rate string into a scale-6 integer. */
export function parseRate(input: string | number): bigint {
  const raw = typeof input === 'number' ? input.toFixed(RATE_SCALE) : input.trim();

  const match = RATE_PATTERN.exec(raw);
  if (match === null || (match[2] ?? '') === '' && (match[3] ?? '') === '') {
    throw new DecimalParseError(raw, 'it is not a plain decimal number');
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const integerPart = match[2] ?? '';
  const fractionPart = match[3] ?? '';

  if (fractionPart.length > RATE_SCALE) {
    const excess = fractionPart.slice(RATE_SCALE);
    if (/[^0]/.test(excess)) {
      throw new DecimalParseError(
        raw,
        `an exchange rate may carry at most ${RATE_SCALE} decimal places`,
      );
    }
  }

  const normalisedFraction = fractionPart.slice(0, RATE_SCALE).padEnd(RATE_SCALE, '0');
  return sign * BigInt(`${integerPart === '' ? '0' : integerPart}${normalisedFraction}`);
}

/**
 * Applies a scale-6 rate to a scale-4 amount, returning a scale-4 amount.
 *
 * The intermediate product is scale 10 and held exactly in a bigint, so the
 * conversion rounds exactly once — at the end — rather than accumulating error
 * through the multiplication.
 */
export function applyRateScaled(
  amount: bigint,
  rate: bigint,
  mode: RoundingMode = 'HALF_UP',
): bigint {
  return guardRange(divideRounded(amount * rate, RATE_FACTOR, mode));
}

/** Renders a scale-6 rate as a decimal string. */
export function formatRate(rate: bigint): string {
  const negative = rate < 0n;
  const digits = (negative ? -rate : rate).toString().padStart(RATE_SCALE + 1, '0');
  const integerPart = digits.slice(0, digits.length - RATE_SCALE);
  const fractionPart = digits.slice(digits.length - RATE_SCALE);
  return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
}
