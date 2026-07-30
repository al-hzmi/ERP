import { describe, expect, it } from 'vitest';
import {
  isLineComplete,
  isRate,
  summariseDraft,
  toApiLines,
  type DraftLine,
} from '@/lib/utils/invoice-draft';
import {
  isJournalLineComplete,
  isJournalLineContradictory,
  summariseJournal,
  type DraftJournalLine,
} from '@/lib/utils/journal-draft';

/**
 * The arithmetic the two entry screens show while someone is typing.
 *
 * Worth testing away from React because it is where the screens can be wrong in a
 * way the user believes: the totals on the invoice form and the balance banner on
 * the journal form are what someone reads before deciding to save. A component test
 * would assert that a number reached the DOM; these assert that it is the right one.
 *
 * The recurring theme is the half-typed value. A field holds `""` before it is
 * filled and `"12."` in the middle of `"12.5"`, and the domain constructors throw on
 * both — so most of what follows is about a line that is not ready yet being left
 * out of the total rather than crashing it or counting as zero.
 */

function line(overrides: Partial<DraftLine> = {}): DraftLine {
  return {
    id: '1',
    productId: 'product-1',
    quantity: '2',
    unitPrice: '100',
    discount: '',
    taxRate: '15',
    descriptionAr: '',
    ...overrides,
  };
}

function journalLine(overrides: Partial<DraftJournalLine> = {}): DraftJournalLine {
  return { id: '1', accountId: 'account-1', debit: '', credit: '', descriptionAr: '', ...overrides };
}

describe('invoice draft — line completeness', () => {
  it('accepts a filled line', () => {
    expect(isLineComplete(line())).toBe(true);
  });

  it('treats a blank discount as complete, because it is optional', () => {
    expect(isLineComplete(line({ discount: '' }))).toBe(true);
  });

  it.each([
    ['no product chosen', { productId: '' }],
    ['quantity still empty', { quantity: '' }],
    ['quantity mid-typing', { quantity: '2.' }],
    ['quantity of zero', { quantity: '0' }],
    ['price still empty', { unitPrice: '' }],
    ['price mid-typing', { unitPrice: '99.' }],
    ['discount mid-typing', { discount: '5.' }],
    ['tax rate above 100', { taxRate: '150' }],
    ['negative quantity', { quantity: '-2' }],
  ])('rejects a line with %s', (_label, overrides) => {
    expect(isLineComplete(line(overrides))).toBe(false);
  });

  it('accepts a zero price, which is a legitimate free-of-charge line', () => {
    expect(isLineComplete(line({ unitPrice: '0' }))).toBe(true);
  });
});

describe('invoice draft — totals', () => {
  it('computes subtotal, tax and total exactly', () => {
    const result = summariseDraft([line({ quantity: '2', unitPrice: '100', taxRate: '15' })], 'SAR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.subtotal).toBe('200.00');
    expect(result.totals.taxTotal).toBe('30.00');
    expect(result.totals.total).toBe('230.00');
  });

  it('subtracts a line discount before tax', () => {
    // 200 gross, 20 discount, 15% of 180 = 27, so 207 — not 15% of 200 less 20.
    const result = summariseDraft(
      [line({ quantity: '2', unitPrice: '100', discount: '20', taxRate: '15' })],
      'SAR',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.discountTotal).toBe('20.00');
    expect(result.totals.taxTotal).toBe('27.00');
    expect(result.totals.total).toBe('207.00');
  });

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 at three lines of 0.1 must be 0.30, not 0.30000000000000004.
    const result = summariseDraft(
      ['a', 'b', 'c'].map((id) =>
        line({ id, productId: `product-${id}`, quantity: '1', unitPrice: '0.1', taxRate: '0' }),
      ),
      'SAR',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.total).toBe('0.30');
  });

  it('leaves half-typed lines out of the total instead of throwing', () => {
    const result = summariseDraft([line(), line({ id: '2', quantity: '3.' })], 'SAR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the finished line counted; the total did not silently gain a zero line.
    expect(result.totals.countedLines).toBe(1);
    expect(result.totals.incompleteLines).toBe(1);
    expect(result.totals.total).toBe('230.00');
  });

  it('reports zeroes for an empty draft rather than failing', () => {
    const result = summariseDraft([line({ productId: '', quantity: '', unitPrice: '' })], 'SAR');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.total).toBe('0.00');
    expect(result.totals.countedLines).toBe(0);
  });

  it('returns the calculator\'s own refusal as a message, not an exception', () => {
    // A discount larger than its line is something a user types on the way to
    // fixing it. The form has to survive the intermediate state.
    const result = summariseDraft(
      [line({ quantity: '1', unitPrice: '10', discount: '999' })],
      'SAR',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('invoice draft — API payload', () => {
  it('sends only complete lines', () => {
    const payload = toApiLines([line(), line({ id: '2', productId: '' })]);

    expect(payload).toHaveLength(1);
    expect(payload[0]?.productId).toBe('product-1');
  });

  it('omits a discount that is blank or zero rather than sending "0"', () => {
    expect(toApiLines([line({ discount: '' })])[0]?.discount).toBeUndefined();
    expect(toApiLines([line({ discount: '0' })])[0]?.discount).toBeUndefined();
    expect(toApiLines([line({ discount: '5' })])[0]?.discount).toBe('5');
  });

  it('trims what it sends', () => {
    expect(toApiLines([line({ quantity: ' 2 ', descriptionAr: '  ملاحظة  ' })])[0]).toMatchObject({
      quantity: '2',
      descriptionAr: 'ملاحظة',
    });
  });
});

describe('isRate', () => {
  it.each(['0', '15', '15.5', '100'])('accepts %s', (value) => {
    expect(isRate(value)).toBe(true);
  });

  it.each(['-1', '101', '15.', 'abc', ''])('rejects %s', (value) => {
    expect(isRate(value)).toBe(false);
  });
});

describe('journal draft — line completeness', () => {
  it('accepts a line with one side', () => {
    expect(isJournalLineComplete(journalLine({ debit: '100' }))).toBe(true);
    expect(isJournalLineComplete(journalLine({ credit: '100' }))).toBe(true);
  });

  it('rejects a line with both sides, which the domain also refuses', () => {
    const both = journalLine({ debit: '100', credit: '100' });

    expect(isJournalLineComplete(both)).toBe(false);
    expect(isJournalLineContradictory(both)).toBe(true);
  });

  it('rejects a line with neither side, no account, or a zero amount', () => {
    expect(isJournalLineComplete(journalLine())).toBe(false);
    expect(isJournalLineComplete(journalLine({ accountId: '', debit: '100' }))).toBe(false);
    expect(isJournalLineComplete(journalLine({ debit: '0' }))).toBe(false);
  });
});

describe('journal draft — balance', () => {
  it('reports a balanced entry as submittable', () => {
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '1500.50' }),
      journalLine({ id: '2', accountId: 'b', credit: '1500.50' }),
    ]);

    expect(balance.totalDebit).toBe('1500.50');
    expect(balance.totalCredit).toBe('1500.50');
    expect(balance.difference).toBe('0.00');
    expect(balance.isBalanced).toBe(true);
    expect(balance.blockingReason).toBeNull();
  });

  it('sums several lines a side', () => {
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '100' }),
      journalLine({ id: '2', accountId: 'b', debit: '50' }),
      journalLine({ id: '3', accountId: 'c', credit: '150' }),
    ]);

    expect(balance.isBalanced).toBe(true);
    expect(balance.countedLines).toBe(3);
  });

  it('is exact to the halala, where a float would not be', () => {
    // Three lines of 0.10 against one of 0.30. In `number` arithmetic the debit
    // side is 0.30000000000000004 and this entry never balances.
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '0.10' }),
      journalLine({ id: '2', accountId: 'b', debit: '0.10' }),
      journalLine({ id: '3', accountId: 'c', debit: '0.10' }),
      journalLine({ id: '4', accountId: 'd', credit: '0.30' }),
    ]);

    expect(balance.isBalanced).toBe(true);
    expect(balance.difference).toBe('0.00');
  });

  it('names the side and the size of an imbalance', () => {
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '100' }),
      journalLine({ id: '2', accountId: 'b', credit: '60' }),
    ]);

    expect(balance.isBalanced).toBe(false);
    expect(balance.difference).toBe('40.00');
    expect(balance.blockingReason).toContain('40.00');
    expect(balance.blockingReason).toContain('المدين');
  });

  it('names the credit side when credits exceed debits', () => {
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '60' }),
      journalLine({ id: '2', accountId: 'b', credit: '100' }),
    ]);

    expect(balance.difference).toBe('-40.00');
    expect(balance.blockingReason).toContain('الدائن');
  });

  it('asks for two lines before it complains about the amount', () => {
    // Telling someone their entry is out by 100 when they have filled in one line
    // is not the information they need next.
    const balance = summariseJournal([journalLine({ accountId: 'a', debit: '100' })]);

    expect(balance.isBalanced).toBe(false);
    expect(balance.blockingReason).toContain('طرفين');
  });

  it('reports a contradictory line ahead of any imbalance', () => {
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '100', credit: '100' }),
      journalLine({ id: '2', accountId: 'b', credit: '100' }),
    ]);

    expect(balance.blockingReason).toContain('البند 1');
  });

  it('never calls a zero-line entry balanced', () => {
    // Two empty lines have equal totals. That is not a balanced entry, it is an
    // empty one, and submitting it would create a journal with nothing in it.
    const balance = summariseJournal([journalLine({ id: '1' }), journalLine({ id: '2' })]);

    expect(balance.isBalanced).toBe(false);
  });

  it('ignores half-typed amounts instead of throwing', () => {
    const balance = summariseJournal([
      journalLine({ id: '1', accountId: 'a', debit: '100' }),
      journalLine({ id: '2', accountId: 'b', credit: '100' }),
      journalLine({ id: '3', accountId: 'c', debit: '55.' }),
    ]);

    expect(balance.countedLines).toBe(2);
    expect(balance.isBalanced).toBe(true);
  });
});
