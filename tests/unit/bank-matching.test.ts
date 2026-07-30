import { describe, expect, it } from 'vitest';
import {
  AUTO_MATCH_THRESHOLD,
  lineAmount,
  lineDirection,
  normaliseReference,
  rankCandidates,
  scoreCandidate,
  unambiguousAutoMatch,
  type PaymentFacts,
  type StatementLineFacts,
} from '@/lib/domain/treasury/bank-matching';

/**
 * Matching a bank statement line to a payment.
 *
 * The tests that matter are the refusals. A matcher that is too eager does not produce a
 * visible error — it produces a reconciliation that balances, was signed off, and quietly
 * settled a 50-halala bank charge against a customer receipt. So most of this file is
 * about candidates that must *not* be offered:
 *
 *   - a different amount, however close;
 *   - the opposite direction;
 *   - and, for the automatic path, anything ambiguous — two identical transfers on the same
 *     day is Tuesday, not an edge case.
 *
 * The convention under test throughout: `debit` is money *in*, following the company's
 * ledger rather than the bank's paper.
 */

function line(overrides: Partial<StatementLineFacts> = {}): StatementLineFacts {
  return {
    id: 'line-1',
    debit: '5000.00',
    credit: '0',
    valueDate: '2026-03-10',
    description: 'تحويل وارد من عميل',
    reference: null,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentFacts> = {}): PaymentFacts {
  return {
    id: 'pay-1',
    voucherNumber: 'RV-2026-00001',
    type: 'RECEIPT',
    amount: '5000.00',
    paymentDate: '2026-03-10',
    bankReference: null,
    checkNumber: null,
    counterpartyName: 'عميل تجريبي',
    ...overrides,
  };
}

describe('lineDirection', () => {
  it('reads a debit as money in, following the ledger not the bank', () => {
    expect(lineDirection(line({ debit: '100', credit: '0' }))).toBe('IN');
  });

  it('reads a credit as money out', () => {
    expect(lineDirection(line({ debit: '0', credit: '100' }))).toBe('OUT');
  });

  it('refuses a line with both sides rather than guessing which was meant', () => {
    // A guess here reverses a transaction.
    expect(lineDirection(line({ debit: '100', credit: '50' }))).toBeNull();
  });

  it('refuses a line with neither side, which is not a transaction', () => {
    expect(lineDirection(line({ debit: '0', credit: '0' }))).toBeNull();
  });

  it('refuses an unparseable amount instead of throwing', () => {
    expect(lineDirection(line({ debit: 'not-a-number', credit: '0' }))).toBeNull();
  });
});

describe('lineAmount', () => {
  it('returns the moved amount whichever side it is on', () => {
    expect(lineAmount(line({ debit: '250.5000', credit: '0' }))).toBe(2_505_000n);
    expect(lineAmount(line({ debit: '0', credit: '250.5000' }))).toBe(2_505_000n);
  });

  it('is null for a malformed line', () => {
    expect(lineAmount(line({ debit: '10', credit: '10' }))).toBeNull();
  });
});

describe('normaliseReference', () => {
  it('makes the same cheque compare equal however it was written', () => {
    expect(normaliseReference('CHQ 001234')).toBe(normaliseReference('chq-001234'));
    expect(normaliseReference('Chq#001234')).toBe('CHQ001234');
  });
});

describe('scoreCandidate — the absolute refusals', () => {
  it('refuses an amount that differs by a single halala', () => {
    // Not a 99% match. It is a bank charge, a partial settlement or a different
    // transaction, and every one of those needs a person.
    expect(scoreCandidate(line({ debit: '5000.00' }), payment({ amount: '4999.99' }))).toBeNull();
  });

  it('refuses a receipt against money going out', () => {
    expect(
      scoreCandidate(line({ debit: '0', credit: '5000.00' }), payment({ type: 'RECEIPT' })),
    ).toBeNull();
  });

  it('refuses a payment against money coming in', () => {
    expect(
      scoreCandidate(line({ debit: '5000.00', credit: '0' }), payment({ type: 'PAYMENT' })),
    ).toBeNull();
  });

  it('accepts a payment out against a credit line', () => {
    expect(
      scoreCandidate(line({ debit: '0', credit: '5000.00' }), payment({ type: 'PAYMENT' })),
    ).not.toBeNull();
  });

  it('refuses a malformed line outright', () => {
    expect(scoreCandidate(line({ debit: '100', credit: '100' }), payment())).toBeNull();
  });

  it('treats trailing zeroes as the same amount', () => {
    // `5000` and `5000.0000` are the same money; a string comparison would disagree.
    expect(scoreCandidate(line({ debit: '5000' }), payment({ amount: '5000.0000' }))).not.toBeNull();
  });
});

describe('scoreCandidate — confidence', () => {
  it('gives amount and direction alone a substantial but not automatic score', () => {
    const scored = scoreCandidate(line({ valueDate: '2026-03-10' }), payment({ paymentDate: '2026-03-10' }));

    expect(scored).not.toBeNull();
    // Same amount, same direction, same day is strong — but with nothing tying the two
    // records together it should still be short of acting unattended.
    expect(scored?.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
  });

  it('reaches the automatic threshold when the bank reference appears in the description', () => {
    const scored = scoreCandidate(
      line({ description: 'حوالة صادرة REF TRX99881 من الحساب', reference: null }),
      payment({ bankReference: 'TRX99881' }),
    );

    expect(scored?.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('finds a cheque number in the reference field', () => {
    const scored = scoreCandidate(
      line({ debit: '0', credit: '5000.00', reference: 'CHQ-001234' }),
      payment({ type: 'PAYMENT', checkNumber: '001234' }),
    );

    expect(scored?.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('credits a voucher number too, but less than a bank reference', () => {
    const byBankRef = scoreCandidate(
      line({ description: 'x TRX99881 y' }),
      payment({ bankReference: 'TRX99881' }),
    );
    const byVoucher = scoreCandidate(
      line({ description: 'x RV-2026-00001 y' }),
      payment({ voucherNumber: 'RV-2026-00001' }),
    );

    // The bank echoing our own reference is stronger evidence than our voucher number
    // appearing in a description someone may have typed.
    expect(byVoucher?.score).toBeLessThan(byBankRef?.score ?? 0);
  });

  it('ignores a reference too short to be evidence', () => {
    // A three-character token matches inside half the descriptions on a statement.
    const scored = scoreCandidate(
      line({ description: 'دفعة رقم 99 إلى المورد' }),
      payment({ bankReference: '99' }),
    );

    expect(scored?.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
  });

  it('scores a closer date higher than a distant one', () => {
    const sameDay = scoreCandidate(line({ valueDate: '2026-03-10' }), payment({ paymentDate: '2026-03-10' }));
    const fourDays = scoreCandidate(line({ valueDate: '2026-03-14' }), payment({ paymentDate: '2026-03-10' }));

    expect(sameDay?.score).toBeGreaterThan(fourDays?.score ?? 0);
  });

  it('still offers a match when the date is far apart, but flags it', () => {
    // A cheque presented three weeks late is still that cheque.
    const scored = scoreCandidate(
      line({ debit: '0', credit: '5000.00', valueDate: '2026-04-05' }),
      payment({ type: 'PAYMENT', paymentDate: '2026-03-10' }),
    );

    expect(scored).not.toBeNull();
    expect(scored?.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
    expect(scored?.reasonsAr.some((reason) => reason.includes('بعيد'))).toBe(true);
  });

  it('never exceeds 100', () => {
    const scored = scoreCandidate(
      line({ description: 'TRX99881', valueDate: '2026-03-10' }),
      payment({ bankReference: 'TRX99881', paymentDate: '2026-03-10' }),
    );

    expect(scored?.score).toBeLessThanOrEqual(100);
  });

  it('explains itself in Arabic', () => {
    const scored = scoreCandidate(line(), payment());

    expect(scored?.reasonsAr.length).toBeGreaterThan(0);
    expect(scored?.reasonsAr[0]).toContain('المبلغ');
  });
});

describe('rankCandidates', () => {
  it('drops everything that cannot be a match and orders the rest best first', () => {
    const ranked = rankCandidates(line({ description: 'TRX777777' }), [
      payment({ id: 'weak' }),
      payment({ id: 'wrong-amount', amount: '1.00' }),
      payment({ id: 'strong', bankReference: 'TRX777777' }),
      payment({ id: 'wrong-direction', type: 'PAYMENT' }),
    ]);

    expect(ranked.map((candidate) => candidate.paymentId)).toEqual(['strong', 'weak']);
  });

  it('returns nothing when no payment can match', () => {
    expect(rankCandidates(line(), [payment({ amount: '7.00' })])).toEqual([]);
  });
});

describe('unambiguousAutoMatch', () => {
  it('picks a single confident candidate', () => {
    const chosen = unambiguousAutoMatch(line({ description: 'TRX777777' }), [
      payment({ id: 'strong', bankReference: 'TRX777777' }),
    ]);

    expect(chosen?.paymentId).toBe('strong');
  });

  it('declines when two candidates are equally good', () => {
    // Two identical transfers to the same supplier on the same day. The evidence does not
    // distinguish them, and picking the first would be a coin toss recorded as a
    // reconciliation.
    const chosen = unambiguousAutoMatch(line({ description: 'دفعة' }), [
      payment({ id: 'a' }),
      payment({ id: 'b' }),
    ]);

    expect(chosen).toBeNull();
  });

  it('declines a candidate below the threshold even when it is the only one', () => {
    const chosen = unambiguousAutoMatch(line({ description: 'لا مرجع هنا' }), [payment({ id: 'only' })]);

    expect(chosen).toBeNull();
  });

  it('picks the clear winner when a weaker candidate also exists', () => {
    const chosen = unambiguousAutoMatch(line({ description: 'REF TRX777777' }), [
      payment({ id: 'weak' }),
      payment({ id: 'strong', bankReference: 'TRX777777' }),
    ]);

    expect(chosen?.paymentId).toBe('strong');
  });

  it('declines when there is nothing to match', () => {
    expect(unambiguousAutoMatch(line(), [])).toBeNull();
  });
});
