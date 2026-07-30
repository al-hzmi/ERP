import { describe, expect, it } from 'vitest';
import {
  buildSchedule,
  duePeriods,
  totalCharge,
  type AssetTerms,
} from '@/lib/domain/assets/depreciation';
import { Money } from '@/lib/domain/shared/money';
import { DateOnly } from '@/lib/domain/shared/value-objects';
import { unwrap } from '@/lib/domain/shared/result';

/**
 * Depreciation schedules.
 *
 * Two properties carry everything, and both are about exactness rather than
 * approximation:
 *
 *   - **the schedule totals `cost − salvage` to the halala**, whatever the method and
 *     however awkward the division. A schedule one halala short leaves an asset that never
 *     fully depreciates, and the residue turns up years later on a disposal that will not
 *     balance;
 *   - **net book value never falls below salvage**, because an asset written past its floor
 *     has been expensed for value the company still holds.
 *
 * So most of what follows checks totals and floors on deliberately awkward numbers, rather
 * than checking that 12,000 over 12 months is 1,000 a month.
 */

function terms(overrides: Partial<AssetTerms> = {}): AssetTerms {
  return {
    acquisitionCost: Money.of('12000.00', 'SAR'),
    salvageValue: Money.of('0', 'SAR'),
    usefulLifeMonths: 12,
    method: 'STRAIGHT_LINE',
    decliningFactor: '2',
    acquisitionDate: unwrap(DateOnly.create('2026-01-15')),
    ...overrides,
  };
}

describe('buildSchedule — validation', () => {
  it('refuses a useful life of zero', () => {
    expect(buildSchedule(terms({ usefulLifeMonths: 0 })).ok).toBe(false);
  });

  it('refuses a fractional useful life', () => {
    expect(buildSchedule(terms({ usefulLifeMonths: 12.5 })).ok).toBe(false);
  });

  it('refuses a zero cost', () => {
    expect(buildSchedule(terms({ acquisitionCost: Money.of('0', 'SAR') })).ok).toBe(false);
  });

  it('refuses a negative salvage value', () => {
    expect(buildSchedule(terms({ salvageValue: Money.of('-1', 'SAR') })).ok).toBe(false);
  });

  it('refuses a salvage value at or above cost', () => {
    // Nothing to depreciate, and a schedule of zeroes would be a silently useless answer.
    expect(
      buildSchedule(
        terms({ acquisitionCost: Money.of('1000', 'SAR'), salvageValue: Money.of('1000', 'SAR') }),
      ).ok,
    ).toBe(false);
  });

  it('refuses a declining factor of 1 or less', () => {
    // A factor of 1 is straight line wearing a different name; below 1 it never depreciates.
    expect(
      buildSchedule(terms({ method: 'DECLINING_BALANCE', decliningFactor: '1' })).ok,
    ).toBe(false);
  });
});

describe('buildSchedule — straight line', () => {
  it('produces one period per month of useful life', () => {
    const schedule = unwrap(buildSchedule(terms({ usefulLifeMonths: 36 })));

    expect(schedule).toHaveLength(36);
  });

  it('charges the same amount every month when it divides evenly', () => {
    const schedule = unwrap(buildSchedule(terms()));

    expect(schedule.every((period) => period.amount.toFixed(2) === '1000.00')).toBe(true);
  });

  it('totals exactly the depreciable amount when it does not divide evenly', () => {
    // 10,000 over 7 months is 1,428.571428… a month. Rounding each share leaves the total
    // short or over; the schedule must still sum to 10,000.00 exactly.
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionCost: Money.of('10000.00', 'SAR'), usefulLifeMonths: 7 }),
      ),
    );

    expect(totalCharge(schedule, 'SAR').toFixed(2)).toBe('10000.00');
  });

  it('totals exactly when a salvage value is deducted', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({
          acquisitionCost: Money.of('10000.00', 'SAR'),
          salvageValue: Money.of('1234.56', 'SAR'),
          usefulLifeMonths: 11,
        }),
      ),
    );

    expect(totalCharge(schedule, 'SAR').toFixed(2)).toBe('8765.44');
  });

  it('ends at exactly the salvage value', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({
          acquisitionCost: Money.of('10000.00', 'SAR'),
          salvageValue: Money.of('1234.56', 'SAR'),
          usefulLifeMonths: 11,
        }),
      ),
    );

    expect(schedule[schedule.length - 1]?.netBookValue.toFixed(2)).toBe('1234.56');
  });

  it('never dips below the salvage value along the way', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({
          acquisitionCost: Money.of('7777.77', 'SAR'),
          salvageValue: Money.of('777.77', 'SAR'),
          usefulLifeMonths: 13,
        }),
      ),
    );

    const salvage = Money.of('777.77', 'SAR');
    expect(schedule.every((period) => period.netBookValue.greaterThanOrEqual(salvage))).toBe(true);
  });

  it('keeps accumulated as the running sum of the amounts actually charged', () => {
    // Not a separate calculation: a schedule whose accumulated column disagrees with its own
    // amounts by a rounding step is one nobody can reconcile.
    const schedule = unwrap(
      buildSchedule(terms({ acquisitionCost: Money.of('1000.00', 'SAR'), usefulLifeMonths: 3 })),
    );

    let running = Money.zero('SAR');
    for (const period of schedule) {
      running = running.add(period.amount);
      expect(period.accumulated.toFixed(4)).toBe(running.toFixed(4));
    }
  });

  it('states net book value as cost less accumulated', () => {
    const schedule = unwrap(buildSchedule(terms()));

    for (const period of schedule) {
      expect(period.netBookValue.toFixed(4)).toBe(
        Money.of('12000.00', 'SAR').subtract(period.accumulated).toFixed(4),
      );
    }
  });
});

describe('buildSchedule — period dates', () => {
  it('starts in the month of acquisition, on its last day', () => {
    // The full-month convention: an asset acquired on the 15th is charged for all of January.
    const schedule = unwrap(
      buildSchedule(terms({ acquisitionDate: unwrap(DateOnly.create('2026-01-15')) })),
    );

    expect(schedule[0]?.periodDate.toString()).toBe('2026-01-31');
  });

  it('dates each period on the last day of its month', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionDate: unwrap(DateOnly.create('2026-01-15')), usefulLifeMonths: 4 }),
      ),
    );

    expect(schedule.map((period) => period.periodDate.toString())).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('gets February right in a leap year', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionDate: unwrap(DateOnly.create('2028-01-10')), usefulLifeMonths: 2 }),
      ),
    );

    expect(schedule[1]?.periodDate.toString()).toBe('2028-02-29');
  });

  it('rolls across a year boundary', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionDate: unwrap(DateOnly.create('2026-11-05')), usefulLifeMonths: 3 }),
      ),
    );

    expect(schedule.map((period) => period.periodDate.toString())).toEqual([
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
    ]);
  });

  it('handles acquisition on the last day of a month', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionDate: unwrap(DateOnly.create('2026-01-31')), usefulLifeMonths: 2 }),
      ),
    );

    expect(schedule.map((period) => period.periodDate.toString())).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
  });
});

describe('buildSchedule — declining balance', () => {
  const decliningTerms = terms({
    method: 'DECLINING_BALANCE',
    acquisitionCost: Money.of('10000.00', 'SAR'),
    salvageValue: Money.of('1000.00', 'SAR'),
    usefulLifeMonths: 24,
    decliningFactor: '2',
  });

  it('charges more in the first month than in the last', () => {
    const schedule = unwrap(buildSchedule(decliningTerms));

    const first = schedule[0];
    const last = schedule[schedule.length - 1];
    expect(first?.amount.greaterThan(last?.amount ?? Money.zero('SAR'))).toBe(true);
  });

  it('totals exactly the depreciable amount', () => {
    // The property a declining balance loses without care: it approaches salvage
    // asymptotically and would otherwise never arrive.
    const schedule = unwrap(buildSchedule(decliningTerms));

    expect(totalCharge(schedule, 'SAR').toFixed(2)).toBe('9000.00');
  });

  it('ends at exactly the salvage value', () => {
    const schedule = unwrap(buildSchedule(decliningTerms));

    expect(schedule[schedule.length - 1]?.netBookValue.toFixed(2)).toBe('1000.00');
  });

  it('never dips below the salvage value', () => {
    const schedule = unwrap(buildSchedule(decliningTerms));
    const salvage = Money.of('1000.00', 'SAR');

    expect(schedule.every((period) => period.netBookValue.greaterThanOrEqual(salvage))).toBe(true);
  });

  it('charges no negative amounts', () => {
    const schedule = unwrap(buildSchedule(decliningTerms));

    expect(schedule.every((period) => !period.amount.isNegative)).toBe(true);
  });

  it('switches to straight line rather than trailing off', () => {
    // Once straight line on the remaining life charges more, it should take over — so the
    // late months settle to a flat amount instead of shrinking towards nothing.
    const schedule = unwrap(buildSchedule(decliningTerms));

    // Compared at full scale, not rounded to halalas: recomputing the straight-line charge
    // month by month passes a `toFixed(2)` comparison while jittering underneath it, and the
    // jitter is exactly what this asserts is absent.
    const tail = schedule.slice(-4, -1).map((period) => period.amount.toFixed(4));
    expect(new Set(tail).size).toBe(1);
  });

  it('is monotonically non-increasing', () => {
    // A charge that rose partway through would mean the switch flipped back and forth, which
    // is not a schedule anyone could explain to an auditor.
    const schedule = unwrap(buildSchedule(decliningTerms));

    for (let index = 1; index < schedule.length - 1; index += 1) {
      const previous = schedule[index - 1]?.amount;
      const current = schedule[index]?.amount;
      if (previous === undefined || current === undefined) continue;
      expect(current.lessThanOrEqual(previous)).toBe(true);
    }
  });

  it('depreciates faster at a higher factor', () => {
    const double = unwrap(buildSchedule(decliningTerms));
    const gentle = unwrap(buildSchedule({ ...decliningTerms, decliningFactor: '1.5' }));

    expect(double[0]?.amount.greaterThan(gentle[0]?.amount ?? Money.zero('SAR'))).toBe(true);
  });

  it('totals exactly on an awkward cost and life', () => {
    const schedule = unwrap(
      buildSchedule({
        ...decliningTerms,
        acquisitionCost: Money.of('3333.33', 'SAR'),
        salvageValue: Money.of('333.33', 'SAR'),
        usefulLifeMonths: 7,
        decliningFactor: '2.5',
      }),
    );

    expect(totalCharge(schedule, 'SAR').toFixed(2)).toBe('3000.00');
    expect(schedule[schedule.length - 1]?.netBookValue.toFixed(2)).toBe('333.33');
  });

  it('handles a single-month life', () => {
    const schedule = unwrap(
      buildSchedule({ ...decliningTerms, usefulLifeMonths: 1 }),
    );

    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.amount.toFixed(2)).toBe('9000.00');
  });
});

describe('duePeriods', () => {
  it('includes a period whose month has ended', () => {
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionDate: unwrap(DateOnly.create('2026-01-15')), usefulLifeMonths: 4 }),
      ),
    );

    const due = duePeriods(schedule, unwrap(DateOnly.create('2026-02-28')));

    expect(due.map((period) => period.periodDate.toString())).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
  });

  it('excludes a month still running', () => {
    // The 31st of March is due once March has ended, not when someone opens the screen on
    // the 10th.
    const schedule = unwrap(
      buildSchedule(
        terms({ acquisitionDate: unwrap(DateOnly.create('2026-01-15')), usefulLifeMonths: 4 }),
      ),
    );

    const due = duePeriods(schedule, unwrap(DateOnly.create('2026-03-10')));

    expect(due).toHaveLength(2);
  });

  it('returns nothing before the first period ends', () => {
    const schedule = unwrap(
      buildSchedule(terms({ acquisitionDate: unwrap(DateOnly.create('2026-01-15')) })),
    );

    expect(duePeriods(schedule, unwrap(DateOnly.create('2026-01-20')))).toEqual([]);
  });
});
