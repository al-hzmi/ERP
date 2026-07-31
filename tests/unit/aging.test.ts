import { describe, expect, it } from 'vitest';
import {
  ageOpenItems,
  bucketFor,
  exposurePercent,
  fromScaled,
  overdueDays,
  type OpenItem,
} from '@/lib/domain/collections/aging';
import { toScaled } from '@/lib/domain/approvals/rule-evaluator';

/**
 * Receivable ageing.
 *
 * This module decides whether a customer is cut off, so the cases that matter are the bucket
 * boundaries, the grace arithmetic, and the values that must *not* be silently coerced. A
 * bucket total assembled with `Number` addition drifts by a fils per few thousand invoices —
 * enough to put a customer either side of a credit limit for reasons nobody can reproduce.
 */

const D = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('overdueDays', () => {
  it('counts whole days past due', () => {
    expect(overdueDays(D('2026-03-31'), D('2026-03-01'), 0)).toBe(30);
  });

  it('deducts the grace period from the age, not from the bucket', () => {
    // An invoice due 40 days ago on 10 days' grace is 30 days overdue. Bucketing the raw 40
    // and "allowing" the first bucket gives the same answer only when grace happens to be 30.
    expect(overdueDays(D('2026-04-10'), D('2026-03-01'), 10)).toBe(30);
  });

  it('is negative before the due date', () => {
    expect(overdueDays(D('2026-03-01'), D('2026-03-31'), 0)).toBe(-30);
  });

  it('is zero on the due date itself', () => {
    // Due today is not overdue. The strict `> 0` in the bucketing depends on this.
    expect(overdueDays(D('2026-03-01'), D('2026-03-01'), 0)).toBe(0);
  });
});

describe('bucketFor', () => {
  it('puts the boundaries where the report says they are', () => {
    expect(bucketFor(-5)).toBe('current');
    expect(bucketFor(0)).toBe('current');
    expect(bucketFor(1)).toBe('days1to30');
    expect(bucketFor(30)).toBe('days1to30');
    expect(bucketFor(31)).toBe('days31to60');
    expect(bucketFor(60)).toBe('days31to60');
    expect(bucketFor(61)).toBe('days61to90');
    expect(bucketFor(90)).toBe('days61to90');
    expect(bucketFor(91)).toBe('over90');
  });
});

describe('ageOpenItems', () => {
  const items: OpenItem[] = [
    { overdueDays: -5, outstanding: '1000.00' },
    { overdueDays: 15, outstanding: '2000.00' },
    { overdueDays: 45, outstanding: '3000.00' },
    { overdueDays: 75, outstanding: '4000.00' },
    { overdueDays: 120, outstanding: '5000.00' },
  ];

  it('files each item in its bucket', () => {
    const profile = ageOpenItems(items);

    expect(fromScaled(profile.current)).toBe('1000.0000');
    expect(fromScaled(profile.days1to30)).toBe('2000.0000');
    expect(fromScaled(profile.days31to60)).toBe('3000.0000');
    expect(fromScaled(profile.days61to90)).toBe('4000.0000');
    expect(fromScaled(profile.over90)).toBe('5000.0000');
  });

  it('totals and overdue agree with the buckets', () => {
    const profile = ageOpenItems(items);

    expect(fromScaled(profile.total)).toBe('15000.0000');
    // Overdue excludes current — the figure the dashboard leads with.
    expect(fromScaled(profile.overdue)).toBe('14000.0000');
    expect(profile.total).toBe(profile.current + profile.overdue);
  });

  it('reports the age of the oldest overdue item', () => {
    expect(ageOpenItems(items).oldestOverdueDays).toBe(120);
  });

  it('does not let a credit note set the oldest age', () => {
    // A two-year-old credit note offsetting a fresh invoice does not make the balance two
    // years old. It reduces the total; it is not itself overdue.
    const profile = ageOpenItems([
      { overdueDays: 10, outstanding: '1000.00' },
      { overdueDays: 700, outstanding: '-400.00' },
    ]);

    expect(profile.oldestOverdueDays).toBe(10);
    expect(fromScaled(profile.total)).toBe('600.0000');
  });

  it('sums exactly where floating point would drift', () => {
    // Ten thousand items of 0.1 each. `Number` addition gives 999.9999999999147.
    const many: OpenItem[] = Array.from({ length: 10_000 }, () => ({
      overdueDays: 10,
      outstanding: '0.10',
    }));

    expect(fromScaled(ageOpenItems(many).total)).toBe('1000.0000');
  });

  it('skips an unparseable amount rather than counting it as zero', () => {
    // A malformed row must not quietly shrink a balance that decides whether the company
    // keeps selling to somebody.
    const profile = ageOpenItems([
      { overdueDays: 10, outstanding: '1000.00' },
      { overdueDays: 10, outstanding: 'not-a-number' },
    ]);

    expect(fromScaled(profile.total)).toBe('1000.0000');
  });

  it('ignores a fully settled item', () => {
    // Zero contributes nothing and would only pollute the oldest age with something nobody
    // owes.
    const profile = ageOpenItems([
      { overdueDays: 300, outstanding: '0' },
      { overdueDays: 10, outstanding: '500' },
    ]);

    expect(profile.oldestOverdueDays).toBe(10);
  });

  it('returns an empty profile for no items', () => {
    const profile = ageOpenItems([]);
    expect(profile.total).toBe(0n);
    expect(profile.oldestOverdueDays).toBe(0);
  });
});

describe('fromScaled', () => {
  it('round-trips through toScaled', () => {
    for (const value of ['0.0000', '1.0000', '1234.5678', '999999.9999']) {
      expect(fromScaled(toScaled(value) as bigint)).toBe(value);
    }
  });

  it('handles negatives and sub-unit values', () => {
    expect(fromScaled(-15000n)).toBe('-1.5000');
    expect(fromScaled(1n)).toBe('0.0001');
    expect(fromScaled(0n)).toBe('0.0000');
  });
});

describe('exposurePercent', () => {
  it('is the balance over the limit, as a percentage', () => {
    expect(exposurePercent(toScaled('50000') as bigint, toScaled('100000') as bigint)).toBe(
      '50.0000',
    );
  });

  it('is not capped at 100', () => {
    // A customer at 300% of their limit is a real and important number. Capping it would make
    // the most alarming rules in the system unwritable.
    expect(exposurePercent(toScaled('300000') as bigint, toScaled('100000') as bigint)).toBe(
      '300.0000',
    );
  });

  it('is null when there is no limit, not zero', () => {
    // Zero would sort an unlimited account as the safest on the ledger, which is the opposite
    // of what no limit means.
    expect(exposurePercent(toScaled('50000') as bigint, 0n)).toBeNull();
  });

  it('keeps four decimals of the percentage rather than truncating to whole percent', () => {
    expect(exposurePercent(toScaled('1') as bigint, toScaled('3') as bigint)).toBe('33.3333');
  });
});
