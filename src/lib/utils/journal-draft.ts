import { formatScaled, parseScaled } from '@/lib/domain/shared/scaled-decimal';

/**
 * The balance arithmetic behind the journal entry screen.
 *
 * The screen's whole job is to answer one question continuously — does this entry
 * balance — and to refuse to submit until it does. That number has to be exact for
 * the same reason every other number in this system does: `0.1 + 0.2` is not `0.3`,
 * and an entry the form called balanced that PostgreSQL then rejects is the worst
 * possible outcome, because the user has no way to see the difference.
 *
 * So the running totals are `bigint` counts of 1/10,000 — the same representation
 * `Money` uses — rather than `number`, and a line that is mid-typing is excluded
 * rather than coerced to zero.
 */

export interface DraftJournalLine {
  readonly id: string;
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
  readonly descriptionAr: string;
}

export interface JournalBalance {
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** Signed: positive means debits exceed credits. */
  readonly difference: string;
  readonly isBalanced: boolean;
  /** Lines complete enough to count toward the totals. */
  readonly countedLines: number;
  /**
   * Why the entry cannot be submitted yet, in Arabic, or `null` when it can.
   *
   * One reason at a time, and the most fundamental first: telling someone their
   * entry is out by 40.00 when they have only filled in one line is not the
   * information they need.
   */
  readonly blockingReason: string | null;
}

const AMOUNT = /^\d+(\.\d{1,4})?$/;

function isAmount(value: string): boolean {
  return AMOUNT.test(value.trim());
}

/**
 * The scale-4 value of a field, or `null` when it is blank, unparseable or zero.
 *
 * `parseScaled` throws on anything it cannot read, and a form field is unreadable
 * for most of the time someone is typing into it, so the regex screens it first.
 */
function parsed(value: string): bigint | null {
  const trimmed = value.trim();
  if (trimmed === '' || !isAmount(trimmed)) return null;
  const scaled = parseScaled(trimmed);
  return scaled === 0n ? null : scaled;
}

/**
 * A line counts when it names an account and carries exactly one non-zero side.
 *
 * Exactly one, not at least one: a line with both is what the domain rejects, and
 * the form should say so before the round trip rather than after it.
 */
export function isJournalLineComplete(line: DraftJournalLine): boolean {
  if (line.accountId === '') return false;
  const debit = parsed(line.debit);
  const credit = parsed(line.credit);
  return (debit !== null) !== (credit !== null);
}

export function isJournalLineContradictory(line: DraftJournalLine): boolean {
  return parsed(line.debit) !== null && parsed(line.credit) !== null;
}

export function summariseJournal(lines: readonly DraftJournalLine[]): JournalBalance {
  let debit = 0n;
  let credit = 0n;
  let counted = 0;

  for (const line of lines) {
    if (!isJournalLineComplete(line)) continue;
    counted += 1;

    const lineDebit = parsed(line.debit);
    if (lineDebit !== null) {
      debit += lineDebit;
      continue;
    }

    const lineCredit = parsed(line.credit);
    if (lineCredit !== null) credit += lineCredit;
  }

  const difference = debit - credit;
  const isBalanced = difference === 0n && counted >= 2;

  return {
    totalDebit: formatScaled(debit, 2),
    totalCredit: formatScaled(credit, 2),
    difference: formatScaled(difference, 2),
    isBalanced,
    countedLines: counted,
    blockingReason: blockingReason(lines, counted, difference),
  };
}

function blockingReason(
  lines: readonly DraftJournalLine[],
  counted: number,
  difference: bigint,
): string | null {
  const contradictory = lines.findIndex(isJournalLineContradictory);
  if (contradictory !== -1) {
    return `البند ${contradictory + 1}: لا يمكن أن يكون مديناً ودائناً في آن واحد.`;
  }

  if (counted < 2) {
    return 'القيد يجب أن يحتوي على طرفين على الأقل — مدين ودائن.';
  }

  if (difference !== 0n) {
    const gap = difference < 0n ? -difference : difference;
    const side = difference < 0n ? 'الدائن' : 'المدين';
    return `القيد غير متوازن: ${side} يزيد بمقدار ${formatScaled(gap, 2)}.`;
  }

  return null;
}
