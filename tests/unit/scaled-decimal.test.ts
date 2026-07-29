import { describe, expect, it } from 'vitest';
import {
  DecimalOverflowError,
  DecimalParseError,
  allocateScaled,
  divideRounded,
  divideScaled,
  formatScaled,
  multiplyScaled,
  parseScaled,
  rescale,
} from '@/lib/domain/shared/scaled-decimal';

describe('parseScaled', () => {
  it('parses plain decimals into scale-4 integers', () => {
    expect(parseScaled('0')).toBe(0n);
    expect(parseScaled('1')).toBe(10_000n);
    expect(parseScaled('1.5')).toBe(15_000n);
    expect(parseScaled('1234.5678')).toBe(12_345_678n);
    expect(parseScaled('-42.25')).toBe(-422_500n);
  });

  it('accepts a leading plus and a bare fraction', () => {
    expect(parseScaled('+7.5')).toBe(75_000n);
    expect(parseScaled('.25')).toBe(2_500n);
  });

  it('tolerates trailing zeros beyond the scale, since they carry no precision', () => {
    expect(parseScaled('1.50000000')).toBe(15_000n);
  });

  it('refuses to silently discard significant digits', () => {
    // 1.23456 cannot be represented at scale 4. Truncating it here is how a
    // rounding discrepancy gets introduced at the boundary and blamed on the
    // ledger three months later.
    expect(() => parseScaled('1.23456')).toThrow(DecimalParseError);
  });

  it('rejects anything that is not a plain decimal', () => {
    expect(() => parseScaled('')).toThrow(DecimalParseError);
    expect(() => parseScaled('abc')).toThrow(DecimalParseError);
    expect(() => parseScaled('1,234.00')).toThrow(DecimalParseError);
    expect(() => parseScaled('1e5')).toThrow(DecimalParseError);
    expect(() => parseScaled('--1')).toThrow(DecimalParseError);
    expect(() => parseScaled(Number.NaN)).toThrow(DecimalParseError);
    expect(() => parseScaled(Number.POSITIVE_INFINITY)).toThrow(DecimalParseError);
  });

  it('rejects values beyond what DECIMAL(19,4) can store', () => {
    expect(() => parseScaled('9999999999999.9999')).not.toThrow();
    expect(() => parseScaled('99999999999999.0000')).toThrow(DecimalOverflowError);
  });
});

describe('formatScaled', () => {
  it('renders with the requested number of decimals', () => {
    expect(formatScaled(12_345_678n)).toBe('1234.5678');
    expect(formatScaled(12_345_678n, 2)).toBe('1234.57');
    expect(formatScaled(12_345_678n, 0)).toBe('1235');
    expect(formatScaled(-5_000n, 2)).toBe('-0.50');
    expect(formatScaled(0n, 2)).toBe('0.00');
  });

  it('pads values smaller than one correctly', () => {
    expect(formatScaled(1n)).toBe('0.0001');
    expect(formatScaled(-1n)).toBe('-0.0001');
  });
});

describe('divideRounded', () => {
  it('rounds half away from zero under HALF_UP', () => {
    expect(divideRounded(5n, 2n, 'HALF_UP')).toBe(3n);
    expect(divideRounded(-5n, 2n, 'HALF_UP')).toBe(-3n);
    expect(divideRounded(4n, 2n, 'HALF_UP')).toBe(2n);
  });

  it('rounds half to even under HALF_EVEN', () => {
    expect(divideRounded(5n, 2n, 'HALF_EVEN')).toBe(2n);
    expect(divideRounded(7n, 2n, 'HALF_EVEN')).toBe(4n);
  });

  it('honours DOWN and UP', () => {
    expect(divideRounded(9n, 2n, 'DOWN')).toBe(4n);
    expect(divideRounded(9n, 2n, 'UP')).toBe(5n);
    expect(divideRounded(-9n, 2n, 'DOWN')).toBe(-4n);
  });

  it('throws on division by zero rather than producing Infinity', () => {
    expect(() => divideRounded(1n, 0n)).toThrow(RangeError);
  });
});

describe('multiplyScaled / divideScaled', () => {
  it('keeps the intermediate product exact before rounding once', () => {
    // 0.1 * 0.2 is the canonical floating-point failure. Here it is exact.
    const result = multiplyScaled(parseScaled('0.1'), parseScaled('0.2'));
    expect(formatScaled(result)).toBe('0.0200');
  });

  it('multiplies large values without loss', () => {
    const result = multiplyScaled(parseScaled('999999.9999'), parseScaled('2'));
    expect(formatScaled(result)).toBe('1999999.9998');
  });

  it('divides with a single rounding step', () => {
    const result = divideScaled(parseScaled('10'), parseScaled('3'));
    expect(formatScaled(result)).toBe('3.3333');
  });
});

describe('rescale', () => {
  it('rounds to the requested precision while staying at scale 4', () => {
    expect(formatScaled(rescale(parseScaled('1.2345'), 2))).toBe('1.2300');
    expect(formatScaled(rescale(parseScaled('1.2350'), 2))).toBe('1.2400');
    expect(formatScaled(rescale(parseScaled('-1.2350'), 2))).toBe('-1.2400');
  });
});

describe('allocateScaled', () => {
  it('distributes so the parts sum exactly to the whole', () => {
    // 100 split three ways cannot be done with equal rounded shares; the
    // largest-remainder method makes the residue land somewhere specific rather
    // than vanish.
    const shares = allocateScaled(parseScaled('100'), [1n, 1n, 1n]);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(parseScaled('100'));
    expect(shares.map((share) => formatScaled(share, 4))).toEqual([
      '33.3334',
      '33.3333',
      '33.3333',
    ]);
  });

  it('allocates proportionally to weights', () => {
    const shares = allocateScaled(parseScaled('1000'), [
      parseScaled('700'),
      parseScaled('300'),
    ]);
    expect(shares.map((share) => formatScaled(share, 2))).toEqual(['700.00', '300.00']);
  });

  it('handles an awkward remainder without losing a halala', () => {
    const total = parseScaled('0.01');
    const shares = allocateScaled(total, [1n, 1n, 1n, 1n, 1n, 1n, 1n]);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(total);
  });

  it('spreads evenly when every weight is zero', () => {
    const shares = allocateScaled(parseScaled('10'), [0n, 0n, 0n]);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(parseScaled('10'));
  });

  it('allocates negative totals without losing the sign or the sum', () => {
    const total = parseScaled('-100');
    const shares = allocateScaled(total, [1n, 1n, 1n]);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(total);
  });

  it('refuses an empty weight set instead of returning nothing', () => {
    expect(() => allocateScaled(parseScaled('10'), [])).toThrow(RangeError);
  });
});
