/**
 * Deterministic pseudo-random generation for the data generator.
 *
 * `Math.random()` would make every seed run produce a different dataset, which
 * means a bug that only appears with one particular combination of quantities
 * can never be reproduced. mulberry32 is seeded from an environment variable, so
 * the same seed always yields byte-identical data — and a failing dataset can be
 * handed to a colleague as a single number.
 */

export class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    // Any 32-bit state works; the >>> 0 keeps it unsigned across arithmetic.
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** A decimal string with `decimals` places, uniform in [min, max]. */
  decimal(min: number, max: number, decimals = 2): string {
    const value = this.next() * (max - min) + min;
    return value.toFixed(decimals);
  }

  /** Picks one element. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Cannot pick from an empty list');
    }
    const chosen = items[this.int(0, items.length - 1)];
    if (chosen === undefined) {
      throw new RangeError('Random pick produced an out-of-range index');
    }
    return chosen;
  }

  /** Picks `count` distinct elements, or all of them if the list is shorter. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const chosen: T[] = [];
    const take = Math.min(count, pool.length);

    for (let i = 0; i < take; i += 1) {
      const index = this.int(0, pool.length - 1);
      const [item] = pool.splice(index, 1);
      if (item !== undefined) chosen.push(item);
    }

    return chosen;
  }

  /** True with probability `probability` (0..1). */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /**
   * Picks by relative weight.
   *
   * Used to make the generated data look like a real business: a handful of
   * customers account for most of the revenue, most invoices are small, and a
   * few are large. Uniform sampling produces data that is statistically tidy and
   * completely unlike anything an accountant has ever seen.
   */
  weighted<T>(entries: readonly { value: T; weight: number }[]): T {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = this.next() * total;

    for (const entry of entries) {
      threshold -= entry.weight;
      if (threshold <= 0) return entry.value;
    }

    const last = entries[entries.length - 1];
    if (last === undefined) throw new RangeError('Cannot pick from an empty weighted list');
    return last.value;
  }

  /** A date uniformly distributed between two bounds, at UTC midnight. */
  date(from: Date, to: Date): Date {
    const span = to.getTime() - from.getTime();
    const picked = new Date(from.getTime() + Math.floor(this.next() * span));
    return new Date(Date.UTC(picked.getUTCFullYear(), picked.getUTCMonth(), picked.getUTCDate()));
  }

  /**
   * A business date — never a Friday or Saturday, which are the weekend in Saudi
   * Arabia. Invoices dated on the weekend are a small but persistent tell that a
   * dataset was generated rather than recorded.
   */
  businessDate(from: Date, to: Date): Date {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.date(from, to);
      const day = candidate.getUTCDay();
      if (day !== 5 && day !== 6) return candidate;
    }
    return this.date(from, to);
  }

  /** Shuffles a copy, leaving the input untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = copy[i];
      const b = copy[j];
      if (a !== undefined && b !== undefined) {
        copy[i] = b;
        copy[j] = a;
      }
    }
    return copy;
  }
}

/**
 * Generates a syntactically valid ZATCA VAT number: 15 digits, first and last
 * are 3, positions 11–13 are the branch/entity identifier.
 */
export function generateVatNumber(random: DeterministicRandom): string {
  const middle = Array.from({ length: 9 }, () => random.int(0, 9)).join('');
  return `3${middle}0003`.slice(0, 14) + '3';
}

/** A plausible Saudi mobile number in the 05x range. */
export function generatePhone(random: DeterministicRandom): string {
  const prefix = random.pick(['050', '053', '054', '055', '056', '057', '058', '059']);
  const rest = Array.from({ length: 7 }, () => random.int(0, 9)).join('');
  return `${prefix}${rest}`;
}

/** A syntactically valid Saudi IBAN (SA + 2 check digits + 22 characters). */
export function generateIban(random: DeterministicRandom): string {
  const bank = random.int(10, 99);
  const account = Array.from({ length: 18 }, () => random.int(0, 9)).join('');
  const check = random.int(10, 99);
  return `SA${check}${bank}${account}`;
}

/** A 10-digit national ID / iqama number. */
export function generateNationalId(random: DeterministicRandom): string {
  const leading = random.pick(['1', '2']);
  const rest = Array.from({ length: 9 }, () => random.int(0, 9)).join('');
  return `${leading}${rest}`;
}
