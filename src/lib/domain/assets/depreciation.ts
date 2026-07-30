import { Money } from '@/lib/domain/shared/money';
import { DomainErrors, type DomainError } from '@/lib/domain/shared/errors';
import { err, ok, type Result } from '@/lib/domain/shared/result';
import { DateOnly } from '@/lib/domain/shared/value-objects';

/**
 * Depreciation schedules.
 *
 * Pure, and the only place the arithmetic lives. What makes this worth isolating is that
 * two properties have to hold *exactly*, not approximately, and both are easy to lose:
 *
 *   1. **The schedule totals `cost − salvage`, to the halala.** Not "close enough after
 *      rounding". A schedule whose parts sum to one halala less than the depreciable amount
 *      leaves an asset that never fully depreciates, and the residue surfaces years later as
 *      an unexplainable balance on a disposal.
 *   2. **Net book value never drops below salvage.** Salvage is the floor by definition;
 *      an asset depreciated past it has been expensed for value the company still holds.
 *
 * `Money.split` and largest-remainder allocation give the first for straight line. For
 * declining balance the arithmetic is inherently uneven, so the last period is made to take
 * exactly the remainder — which is also what stops a declining balance, which approaches
 * zero asymptotically, from never arriving.
 *
 * ## The conventions this picks, because they are choices
 *
 * **Monthly periods, dated on the last day of the month.** A month is the finest period any
 * of this system's reports distinguish, and a schedule keyed to month ends joins cleanly to
 * the fiscal calendar.
 *
 * **A full month in the month of acquisition.** IFRS requires depreciation from the date the
 * asset is available for use; the alternatives are pro-rata by days or a half-month
 * convention. Full-month is the simplest defensible reading and the one most small-company
 * policies state. It is a policy, not a law — an asset acquired on the 28th is depreciated
 * for that whole month here.
 *
 * **Declining balance switches to straight line when straight line gives more.** Without
 * the switch, a declining balance never reaches salvage and the final period absorbs a lump
 * that distorts the last month's result. The switch is the textbook method for exactly that
 * reason.
 */

export type DepreciationMethod = 'STRAIGHT_LINE' | 'DECLINING_BALANCE';

export interface AssetTerms {
  /** What the asset cost. Must be positive. */
  readonly acquisitionCost: Money;
  /** What it is expected to be worth at the end of its life. The floor for NBV. */
  readonly salvageValue: Money;
  readonly usefulLifeMonths: number;
  readonly method: DepreciationMethod;
  /** `2` is double declining. Ignored for straight line. */
  readonly decliningFactor: string;
  readonly acquisitionDate: DateOnly;
}

export interface SchedulePeriod {
  /** Last day of the month this charge belongs to. */
  readonly periodDate: DateOnly;
  readonly amount: Money;
  /** Accumulated depreciation after this period. */
  readonly accumulated: Money;
  /** `cost − accumulated` after this period. Never below salvage. */
  readonly netBookValue: Money;
}

/** Last day of the month `offset` months after `from`. */
function monthEnd(from: DateOnly, offset: number): DateOnly {
  // Day 0 of the *next* month is the last day of the one before it, which avoids
  // enumerating month lengths and gets February right in a leap year for free.
  const date = new Date(Date.UTC(from.year, from.month - 1 + offset + 1, 0));
  return DateOnly.fromDate(date);
}

/**
 * The full schedule for an asset's life.
 *
 * Returns a failure rather than throwing on terms that cannot produce a schedule: an asset
 * is entered by a person, and "useful life of zero months" is a typo to be reported, not an
 * exception to be caught.
 */
export function buildSchedule(terms: AssetTerms): Result<SchedulePeriod[], DomainError> {
  if (!Number.isInteger(terms.usefulLifeMonths) || terms.usefulLifeMonths <= 0) {
    return err(
      DomainErrors.validation(
        'العمر الإنتاجي يجب أن يكون عدد أشهر أكبر من صفر.',
        'The useful life must be a whole number of months greater than zero.',
        'usefulLifeMonths',
      ),
    );
  }

  if (!terms.acquisitionCost.isPositive) {
    return err(
      DomainErrors.validation(
        'تكلفة الأصل يجب أن تكون أكبر من صفر.',
        'The acquisition cost must be greater than zero.',
        'acquisitionCost',
      ),
    );
  }

  if (terms.salvageValue.isNegative) {
    return err(
      DomainErrors.validation(
        'قيمة الإنقاذ لا يمكن أن تكون سالبة.',
        'The salvage value cannot be negative.',
        'salvageValue',
      ),
    );
  }

  if (terms.salvageValue.greaterThanOrEqual(terms.acquisitionCost)) {
    return err(
      DomainErrors.validation(
        'قيمة الإنقاذ يجب أن تكون أقل من تكلفة الأصل.',
        'The salvage value must be less than the acquisition cost.',
        'salvageValue',
      ),
    );
  }

  const depreciable = terms.acquisitionCost.subtract(terms.salvageValue);

  const amounts =
    terms.method === 'STRAIGHT_LINE'
      ? straightLine(depreciable, terms.usefulLifeMonths)
      : decliningBalance(depreciable, terms);

  if (!amounts.ok) return amounts;

  // Walked forward rather than computed per period, so `accumulated` is the running sum of
  // exactly the amounts that will be posted — not a separate calculation that could
  // disagree with them by a rounding step.
  let accumulated = Money.zero(terms.acquisitionCost.currency);
  const periods: SchedulePeriod[] = [];

  for (const [index, amount] of amounts.value.entries()) {
    accumulated = accumulated.add(amount);
    periods.push({
      periodDate: monthEnd(terms.acquisitionDate, index),
      amount,
      accumulated,
      netBookValue: terms.acquisitionCost.subtract(accumulated),
    });
  }

  return ok(periods);
}

/**
 * Equal monthly charges that sum to exactly the depreciable amount.
 *
 * `split` spreads the remainder deterministically rather than rounding each share, which is
 * what makes the total exact. Dividing and rounding would leave the schedule short or over
 * by up to one halala per period.
 */
function straightLine(depreciable: Money, months: number): Result<Money[], DomainError> {
  return ok(depreciable.split(months));
}

/**
 * Declining balance, switching to straight line when straight line charges more.
 *
 * The rate is `factor / usefulLifeMonths` applied to the *opening* net book value each
 * month, so the charge falls as the asset is written down. Two corrections make it a usable
 * schedule rather than a mathematical curiosity:
 *
 *   - **the switch**, because a declining balance approaches salvage asymptotically and
 *     would never reach it inside the asset's life;
 *   - **the final period takes the remainder**, so the total is exact to the halala whatever
 *     the rounding did on the way.
 */
function decliningBalance(depreciable: Money, terms: AssetTerms): Result<Money[], DomainError> {
  const factor = Number(terms.decliningFactor);

  if (!Number.isFinite(factor) || factor <= 1) {
    return err(
      DomainErrors.validation(
        'معامل القسط المتناقص يجب أن يكون أكبر من 1.',
        'The declining-balance factor must be greater than 1.',
        'decliningFactor',
      ),
    );
  }

  const months = terms.usefulLifeMonths;

  const amounts: Money[] = [];
  let remaining = depreciable;

  for (let month = 0; month < months; month += 1) {
    const monthsLeft = months - month;

    // `remaining × factor ÷ months`, as two exact operations rather than one decimal rate.
    // `Money.multiply` refuses a factor carrying more than four decimal places — silently
    // truncating one is how a rate becomes a rounding error — and `factor / months` is
    // `0.3571428571…` for most inputs. Multiplying first keeps every step representable.
    //
    // Applied to the remaining depreciable base rather than to net book value, which is the
    // same thing once salvage is excluded — and excluding it here is what keeps NBV from
    // being driven below the floor.
    const declining = remaining.multiply(terms.decliningFactor).divide(months);
    const straight = remaining.divide(monthsLeft);

    // The switch, and the end of the declining phase in one test. Once straight line over the
    // remaining life charges at least as much, it does so for every month after this one too,
    // so the rest of the schedule is straight line — allocated in a single `split` rather
    // than recomputed month by month.
    //
    // Recomputing `remaining ÷ monthsLeft` each month instead would look equivalent and is
    // not: each division rounds to scale 4, the rounding feeds back into the next `remaining`,
    // and a schedule that is flat by construction comes out jittering by a fraction of a
    // halala from month to month. `split` allocates the whole tail at once by largest
    // remainder, so it totals exactly and never rises.
    if (!declining.greaterThan(straight)) {
      amounts.push(...remaining.split(monthsLeft));
      return ok(amounts);
    }

    // Cannot take more than is left; the floor is salvage, and `remaining` is measured
    // from it.
    const capped = declining.greaterThan(remaining) ? remaining : declining;

    amounts.push(capped);
    remaining = remaining.subtract(capped);
  }

  return ok(amounts);
}

/**
 * The periods of a schedule that are due on or before `asOf` and not yet posted.
 *
 * Trivial, and here rather than in the service because "due" is a domain question: a period
 * dated the 31st of March is due once March has ended, not when someone opens the screen in
 * the middle of it.
 */
export function duePeriods(
  periods: readonly SchedulePeriod[],
  asOf: DateOnly,
): SchedulePeriod[] {
  return periods.filter((period) => !period.periodDate.isAfter(asOf));
}

/** Total of a set of charges. Exposed so a caller need not reimplement the sum. */
export function totalCharge(periods: readonly SchedulePeriod[], currency: string): Money {
  return Money.sum(
    periods.map((period) => period.amount),
    currency,
  );
}
