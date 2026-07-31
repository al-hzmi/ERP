import { describe, expect, it } from 'vitest';
import {
  describeCondition,
  evaluateRule,
  selectGoverningRule,
  toScaled,
  type DocumentFacts,
  type EvaluableRule,
  type RuleCondition,
} from '@/lib/domain/approvals/rule-evaluator';

/**
 * The approval rule evaluator.
 *
 * This is the whole decision — *is this document held, and by which rule* — and it is pure, so
 * every case below runs without a database. The ones that matter are the boundaries and the
 * malformed input, because a rules engine fails by firing when it should not or by silently
 * not firing when it should, and both are invisible in production.
 */

function facts(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    TOTAL_AMOUNT: '10000',
    SUBTOTAL: '9000',
    TAX_AMOUNT: '1000',
    LINE_COUNT: '3',
    MAX_LINE_DISCOUNT_PERCENT: '0',
    ...overrides,
  };
}

function rule(conditions: RuleCondition[], overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: 'rule-1',
    nameAr: 'قاعدة',
    nameEn: 'Rule',
    priority: 100,
    minAmount: '0',
    conditions,
    ...overrides,
  };
}

describe('toScaled', () => {
  it('scales to four places', () => {
    expect(toScaled('1')).toBe(10000n);
    expect(toScaled('0.0001')).toBe(1n);
    expect(toScaled('50000')).toBe(500000000n);
  });

  it('truncates rather than rounds beyond four places', () => {
    // A threshold of 15.00005 is a typo. Rounding it up to 15.0001 would move a boundary the
    // user set, and move it in the direction that fires on *fewer* documents.
    expect(toScaled('15.00005')).toBe(150000n);
  });

  it('returns null for anything unparseable', () => {
    // Load-bearing: an unparseable side makes the clause unevaluable, and an unevaluable
    // clause must not count as satisfied.
    expect(toScaled('abc')).toBeNull();
    expect(toScaled('')).toBeNull();
    expect(toScaled('1.2.3')).toBeNull();
    expect(toScaled('50,000')).toBeNull();
  });
});

describe('evaluateRule', () => {
  it('fires when the condition holds', () => {
    const match = evaluateRule(
      rule([{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '5000' }]),
      facts({ TOTAL_AMOUNT: '10000' }),
    );

    expect(match).not.toBeNull();
    expect(match?.matched).toHaveLength(1);
    expect(match?.matched[0]?.actual).toBe('10000');
    expect(match?.matched[0]?.threshold).toBe('5000');
  });

  it('does not fire on the boundary with a strict operator', () => {
    // The case a float implementation gets wrong: exactly 50000 is not *greater than* 50000.
    expect(
      evaluateRule(
        rule([{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '50000' }]),
        facts({ TOTAL_AMOUNT: '50000' }),
      ),
    ).toBeNull();
  });

  it('fires on the boundary with an inclusive operator', () => {
    expect(
      evaluateRule(
        rule([{ field: 'TOTAL_AMOUNT', operator: 'GTE', value: '50000' }]),
        facts({ TOTAL_AMOUNT: '50000' }),
      ),
    ).not.toBeNull();
  });

  it('compares fractions exactly', () => {
    // `0.1 + 0.2 > 0.3` is true in IEEE-754. A discount of exactly 15 must not clear a
    // `> 15` threshold no matter how the number was arrived at.
    expect(
      evaluateRule(
        rule([{ field: 'MAX_LINE_DISCOUNT_PERCENT', operator: 'GT', value: '15' }]),
        facts({ MAX_LINE_DISCOUNT_PERCENT: '15.0000' }),
      ),
    ).toBeNull();

    expect(
      evaluateRule(
        rule([{ field: 'MAX_LINE_DISCOUNT_PERCENT', operator: 'GT', value: '15' }]),
        facts({ MAX_LINE_DISCOUNT_PERCENT: '15.0001' }),
      ),
    ).not.toBeNull();
  });

  it('ANDs every condition — one failing means the rule does not fire', () => {
    const both: RuleCondition[] = [
      { field: 'TOTAL_AMOUNT', operator: 'GT', value: '50000' },
      { field: 'MAX_LINE_DISCOUNT_PERCENT', operator: 'GT', value: '15' },
    ];

    // Total clears, discount does not.
    expect(
      evaluateRule(rule(both), facts({ TOTAL_AMOUNT: '60000', MAX_LINE_DISCOUNT_PERCENT: '5' })),
    ).toBeNull();

    // Both clear.
    const match = evaluateRule(
      rule(both),
      facts({ TOTAL_AMOUNT: '60000', MAX_LINE_DISCOUNT_PERCENT: '20' }),
    );
    expect(match?.matched).toHaveLength(2);
  });

  it('matches every document when it has no conditions', () => {
    // "Every purchase order needs the manager" is usually the first rule anybody writes.
    // Treating an empty set as *never* matching would make that rule silently do nothing.
    expect(evaluateRule(rule([]), facts())).not.toBeNull();
  });

  it('still honours the legacy minAmount floor', () => {
    // Rules written before conditions existed carry only this. Their behaviour must not change.
    expect(
      evaluateRule(rule([], { minAmount: '50000' }), facts({ TOTAL_AMOUNT: '10000' })),
    ).toBeNull();
    expect(
      evaluateRule(rule([], { minAmount: '50000' }), facts({ TOTAL_AMOUNT: '60000' })),
    ).not.toBeNull();
  });

  it('does not fire when a value is unparseable', () => {
    // Not "treat it as zero", which would fire on every document with a `> 0` rule.
    expect(
      evaluateRule(
        rule([{ field: 'TOTAL_AMOUNT', operator: 'GT', value: 'abc' }]),
        facts({ TOTAL_AMOUNT: '10000' }),
      ),
    ).toBeNull();

    expect(
      evaluateRule(
        rule([{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '100' }]),
        facts({ TOTAL_AMOUNT: 'not-a-number' }),
      ),
    ).toBeNull();
  });

  it('supports every operator', () => {
    const cases: [RuleCondition['operator'], string, boolean][] = [
      ['GT', '9999', true],
      ['GT', '10000', false],
      ['GTE', '10000', true],
      ['LT', '10001', true],
      ['LT', '10000', false],
      ['LTE', '10000', true],
      ['EQ', '10000', true],
      ['EQ', '9999', false],
      ['NEQ', '9999', true],
      ['NEQ', '10000', false],
    ];

    for (const [operator, value, expected] of cases) {
      const match = evaluateRule(
        rule([{ field: 'TOTAL_AMOUNT', operator, value }]),
        facts({ TOTAL_AMOUNT: '10000' }),
      );
      expect(match !== null, `${operator} ${value}`).toBe(expected);
    }
  });
});

describe('selectGoverningRule', () => {
  it('returns null when nothing matches', () => {
    expect(
      selectGoverningRule(
        [rule([{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '99999' }])],
        facts(),
      ),
    ).toBeNull();
  });

  it('picks the lowest priority number when several match', () => {
    const strict = rule([], { id: 'strict', nameAr: 'صارمة', priority: 10 });
    const loose = rule([], { id: 'loose', nameAr: 'مرنة', priority: 50 });

    expect(selectGoverningRule([loose, strict], facts())?.rule.id).toBe('strict');
    // Order of input must not decide it.
    expect(selectGoverningRule([strict, loose], facts())?.rule.id).toBe('strict');
  });

  it('breaks a priority tie on the stricter floor, then the name', () => {
    const high = rule([], { id: 'high', nameAr: 'ب', priority: 10, minAmount: '5000' });
    const low = rule([], { id: 'low', nameAr: 'أ', priority: 10, minAmount: '1000' });

    // Deterministic: two rules matching one document is ordinary, but which one raises the
    // request must not depend on the order the database happened to return.
    expect(selectGoverningRule([low, high], facts())?.rule.id).toBe('high');
    expect(selectGoverningRule([high, low], facts())?.rule.id).toBe('high');
  });

  it('carries the evidence of the winning rule only', () => {
    const winner = rule([{ field: 'TOTAL_AMOUNT', operator: 'GT', value: '5000' }], {
      id: 'winner',
      priority: 1,
    });
    const other = rule([{ field: 'LINE_COUNT', operator: 'GTE', value: '1' }], {
      id: 'other',
      nameAr: 'أخرى',
      priority: 9,
    });

    const match = selectGoverningRule([other, winner], facts());
    expect(match?.rule.id).toBe('winner');
    expect(match?.matched).toHaveLength(1);
    expect(match?.matched[0]?.field).toBe('TOTAL_AMOUNT');
  });
});

describe('describeCondition', () => {
  it('reads as a sentence, with the right unit', () => {
    expect(describeCondition({ field: 'TOTAL_AMOUNT', operator: 'GT', value: '50000' })).toBe(
      'إجمالي المستند أكبر من 50000',
    );
    expect(
      describeCondition({ field: 'MAX_LINE_DISCOUNT_PERCENT', operator: 'GT', value: '15' }),
    ).toBe('أعلى نسبة خصم في سطر أكبر من 15%');
    expect(describeCondition({ field: 'LINE_COUNT', operator: 'GTE', value: '10' })).toBe(
      'عدد السطور أكبر من أو يساوي 10 سطر',
    );
  });
});
