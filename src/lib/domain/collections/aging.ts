import { toScaled } from '@/lib/domain/approvals/rule-evaluator';

/**
 * Receivable ageing arithmetic.
 *
 * Pure, and every sum is `bigint` at four decimal places. That is not ceremony: this module
 * decides whether a customer is cut off, and a bucket total assembled from `Number` addition
 * drifts by a fils per few thousand invoices — enough to put a customer either side of a
 * credit limit for reasons nobody can reproduce.
 *
 * The SQL in `collections-service` buckets and sums server-side for the dashboard, which is
 * right for a report over every customer. This module is what runs on the *credit-hold path*,
 * over one customer's open invoices, where the answer gates a sale and has to be exact and
 * explicable.
 *
 * ## Grace is applied to the age, not to the bucket
 *
 * An invoice due 40 days ago on a customer with 10 days' grace is **30 days overdue**, not 40.
 * Bucketing on the raw age and then "allowing" the first bucket gets the same answer only when
 * grace happens to be 30, and silently disagrees with the credit rule everywhere else — which
 * is exactly the sort of divergence nobody finds until a customer argues about it.
 *
 * ## A credit note is not a negative invoice here
 *
 * It reduces the balance, so it belongs in the total. It has no meaningful *age* of its own —
 * a two-year-old credit note offsetting a fresh invoice does not make the balance two years
 * old. The caller passes outstanding amounts already netted; this module ages what it is given.
 */

/** The four buckets, in the order they are read. */
export type AgingBucketKey = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90';

export interface OpenItem {
  /** Days past due, *after* grace has been deducted. Negative means not yet due. */
  readonly overdueDays: number;
  /** Outstanding amount as a decimal string: total less what has been paid. */
  readonly outstanding: string;
}

export interface AgingProfile {
  readonly current: bigint;
  readonly days1to30: bigint;
  readonly days31to60: bigint;
  readonly days61to90: bigint;
  readonly over90: bigint;
  readonly total: bigint;
  /** Everything past due, which is `total - current`. The number collections cares about. */
  readonly overdue: bigint;
  /** Age of the oldest item that is actually overdue. `0` when nothing is. */
  readonly oldestOverdueDays: number;
}

const EMPTY: AgingProfile = {
  current: 0n,
  days1to30: 0n,
  days31to60: 0n,
  days61to90: 0n,
  over90: 0n,
  total: 0n,
  overdue: 0n,
  oldestOverdueDays: 0,
};

/**
 * Days past due for an invoice, after grace.
 *
 * Exported because the same calculation has to happen in the dashboard's SQL and in the
 * credit-hold path, and the two disagreeing is the failure this whole module is arranged to
 * prevent. `collections-service` mirrors this expression in SQL and an integration test
 * asserts the two agree on the same data.
 */
export function overdueDays(asOf: Date, dueDate: Date, graceDays: number): number {
  const MS_PER_DAY = 86_400_000;
  // Both dates are date-only in the schema, so this is whole days with no timezone drift.
  const raw = Math.floor((asOf.getTime() - dueDate.getTime()) / MS_PER_DAY);
  return raw - graceDays;
}

/** Which bucket an age falls in. One place, so the boundaries cannot drift between callers. */
export function bucketFor(days: number): AgingBucketKey {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'over90';
}

/**
 * Ages a customer's open items into the four buckets.
 *
 * Items whose outstanding amount does not parse are **skipped**, not counted as zero: a
 * malformed row must not quietly shrink a balance that decides whether the company keeps
 * selling to somebody.
 */
export function ageOpenItems(items: readonly OpenItem[]): AgingProfile {
  if (items.length === 0) return EMPTY;

  let current = 0n;
  let days1to30 = 0n;
  let days31to60 = 0n;
  let days61to90 = 0n;
  let over90 = 0n;
  let oldestOverdueDays = 0;

  for (const item of items) {
    const amount = toScaled(item.outstanding);
    if (amount === null) continue;
    // A fully settled item is not an open item. Zero contributes nothing and would only
    // pollute `oldestOverdueDays` with the age of something nobody owes.
    if (amount === 0n) continue;

    const bucket = bucketFor(item.overdueDays);

    switch (bucket) {
      case 'current':
        current += amount;
        break;
      case 'days1to30':
        days1to30 += amount;
        break;
      case 'days31to60':
        days31to60 += amount;
        break;
      case 'days61to90':
        days61to90 += amount;
        break;
      case 'over90':
        over90 += amount;
        break;
    }

    // Only positive balances age. A credit note sitting against the account is not "overdue",
    // and letting it set the oldest age would report a customer as 200 days late on money they
    // are owed.
    if (bucket !== 'current' && amount > 0n && item.overdueDays > oldestOverdueDays) {
      oldestOverdueDays = item.overdueDays;
    }
  }

  const overdue = days1to30 + days31to60 + days61to90 + over90;

  return {
    current,
    days1to30,
    days31to60,
    days61to90,
    over90,
    total: current + overdue,
    overdue,
    oldestOverdueDays,
  };
}

/** A scaled `bigint` back to the decimal string the rest of the system speaks. */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(5, '0');
  const whole = digits.slice(0, -4);
  const fraction = digits.slice(-4);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Outstanding balance as a percentage of the credit limit.
 *
 * `null` when there is no limit — not `0`, and not `Infinity`. A customer with no credit limit
 * has no exposure *ratio*; reporting 0% would sort them as the safest account on the ledger,
 * which is the opposite of what an unlimited account means. The screen shows "بلا حد" and any
 * rule on this field simply does not fire for them.
 *
 * Computed at scale 4 and rendered with two decimals, so the ratio is exact rather than a
 * float division of two floats.
 */
export function exposurePercent(outstanding: bigint, creditLimit: bigint): string | null {
  if (creditLimit <= 0n) return null;
  // × 10000 before dividing keeps four decimal places of the *percentage* through integer
  // division, rather than truncating to whole percent.
  const scaled = (outstanding * 100n * 10_000n) / creditLimit;
  return fromScaled(scaled);
}
