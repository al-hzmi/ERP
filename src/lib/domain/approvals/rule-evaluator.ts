/**
 * The rule evaluator.
 *
 * Pure: no database, no clock, no framework. That is what lets the whole decision — *does this
 * document need approval, and which rule says so* — be tested without a PostgreSQL, and it is
 * why the interception logic lives here rather than inside the service that queries the rows.
 *
 * ## Comparison is decimal, not float
 *
 * Every value on both sides arrives as a decimal string from a `DECIMAL(19,4)` column. Parsing
 * them with `Number` puts money on the floating-point path that the rest of this system spends
 * considerable effort staying off: `0.1 + 0.2 > 0.3` is true in IEEE-754, and a rule reading
 * `discount > 15` firing on a discount of exactly 15 because of representation error is the
 * kind of defect nobody would think to look for.
 *
 * So both sides are scaled to integers at four decimal places and compared as `bigint`. Four
 * places is the schema's scale everywhere, so nothing is lost.
 *
 * ## Conditions are ANDed
 *
 * "Total over 50,000 **and** discount over 15%" is two conditions on one rule, which is how
 * people read a second line added to a rule. OR is two rules — which also keeps the reasons
 * distinguishable, since a request records the single rule that raised it.
 *
 * ## A rule with no conditions matches everything of its type
 *
 * Deliberate, and usually the first rule anybody writes: "every purchase order needs the
 * manager". Treating an empty condition set as *never matching* would make that rule silently
 * do nothing, which is the worse failure — a control that appears configured and is not.
 */

export type ConditionField =
  | 'TOTAL_AMOUNT'
  | 'SUBTOTAL'
  | 'TAX_AMOUNT'
  | 'LINE_COUNT'
  | 'MAX_LINE_DISCOUNT_PERCENT';

export type ConditionOperator = 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ';

export interface RuleCondition {
  readonly field: ConditionField;
  readonly operator: ConditionOperator;
  /** Decimal string, as stored. */
  readonly value: string;
}

/**
 * The document, reduced to the numbers a rule can ask about.
 *
 * Every value is a decimal string for the same reason the conditions are: this is the
 * boundary where floats would otherwise creep in.
 */
export interface DocumentFacts {
  /**
   * Index signature so the whole bag is JSON-assignable: it is stored verbatim on
   * `approval_requests.triggeredBy`, and Prisma's `InputJsonValue` will not accept an
   * interface without one. Every value is still a decimal string.
   */
  readonly [field: string]: string;
  readonly TOTAL_AMOUNT: string;
  readonly SUBTOTAL: string;
  readonly TAX_AMOUNT: string;
  readonly LINE_COUNT: string;
  readonly MAX_LINE_DISCOUNT_PERCENT: string;
}

export interface EvaluableRule {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly priority: number;
  /** The legacy fixed condition. Combined with the rest by AND; 0 means "no floor". */
  readonly minAmount: string;
  readonly conditions: readonly RuleCondition[];
}

export interface RuleMatch {
  readonly rule: EvaluableRule;
  /** Which clauses fired, and against what — stored on the request so it stays explicable. */
  readonly matched: readonly {
    readonly field: ConditionField;
    readonly operator: ConditionOperator;
    readonly threshold: string;
    readonly actual: string;
  }[];
}

/** Four decimal places — the scale of every numeric column this compares. */
const SCALE = 4;

/**
 * Parses a decimal string to a scaled `bigint`.
 *
 * Returns `null` rather than throwing or coercing for anything unparseable. A malformed value
 * in a condition row must make that condition *not match* rather than crash the posting path
 * or, worse, silently compare as zero and fire on every document.
 */
export function toScaled(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;

  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = digits.split('.');

  // Pad or truncate to exactly SCALE places. Truncation rather than rounding: a threshold of
  // 15.00005 is a typo, and rounding it up to 15.0001 would move the boundary a user set.
  const padded = (fraction + '0'.repeat(SCALE)).slice(0, SCALE);
  const scaled = BigInt(whole + padded);

  return negative ? -scaled : scaled;
}

function compare(actual: bigint, operator: ConditionOperator, threshold: bigint): boolean {
  switch (operator) {
    case 'GT':
      return actual > threshold;
    case 'GTE':
      return actual >= threshold;
    case 'LT':
      return actual < threshold;
    case 'LTE':
      return actual <= threshold;
    case 'EQ':
      return actual === threshold;
    case 'NEQ':
      return actual !== threshold;
  }
}

/**
 * Does this rule fire against these facts?
 *
 * Returns the matched clauses when it does, `null` when it does not — so the caller gets the
 * evidence rather than having to recompute it for the audit record.
 */
export function evaluateRule(rule: EvaluableRule, facts: DocumentFacts): RuleMatch | null {
  const total = toScaled(facts.TOTAL_AMOUNT);
  const floor = toScaled(rule.minAmount);

  // The legacy `minAmount` is ANDed with everything else. A rule that predates conditions has
  // an empty condition set, so this alone decides it — which is exactly its old behaviour.
  if (total === null || floor === null) return null;
  if (total < floor) return null;

  const matched: Array<RuleMatch['matched'][number]> = [];

  for (const condition of rule.conditions) {
    const threshold = toScaled(condition.value);
    const actual = toScaled(facts[condition.field]);

    // An unparseable side means the clause cannot be evaluated, and an unevaluable clause
    // must not be treated as satisfied. The rule simply does not fire.
    if (threshold === null || actual === null) return null;
    if (!compare(actual, condition.operator, threshold)) return null;

    matched.push({
      field: condition.field,
      operator: condition.operator,
      threshold: condition.value,
      actual: facts[condition.field],
    });
  }

  return { rule, matched };
}

/**
 * The rule that governs a document, or `null` when none does.
 *
 * Ties on `priority` are broken by the stricter `minAmount` and then by name, so the choice is
 * deterministic. Two rules matching one document is not an error — it is an administrator
 * writing overlapping rules, which is ordinary — but which of them raises the request must not
 * depend on the order the database happened to return.
 *
 * Only one request is raised, because `approval_requests` allows one per entity. Raising the
 * highest-priority match rather than all of them is the honest reading of that constraint:
 * the document is held once, by the rule the administrator ranked first.
 */
export function selectGoverningRule(
  rules: readonly EvaluableRule[],
  facts: DocumentFacts,
): RuleMatch | null {
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    const match = evaluateRule(rule, facts);
    if (match !== null) matches.push(match);
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;

    const floorA = toScaled(a.rule.minAmount) ?? 0n;
    const floorB = toScaled(b.rule.minAmount) ?? 0n;
    if (floorA !== floorB) return floorB > floorA ? 1 : -1;

    return a.rule.nameAr.localeCompare(b.rule.nameAr, 'ar');
  });

  return matches[0] ?? null;
}

/** Arabic labels, so the builder and the inbox describe a rule the same way. */
export const FIELD_LABELS_AR: Record<ConditionField, string> = {
  TOTAL_AMOUNT: 'إجمالي المستند',
  SUBTOTAL: 'الصافي قبل الضريبة',
  TAX_AMOUNT: 'قيمة الضريبة',
  LINE_COUNT: 'عدد السطور',
  MAX_LINE_DISCOUNT_PERCENT: 'أعلى نسبة خصم في سطر',
};

export const OPERATOR_LABELS_AR: Record<ConditionOperator, string> = {
  GT: 'أكبر من',
  GTE: 'أكبر من أو يساوي',
  LT: 'أصغر من',
  LTE: 'أصغر من أو يساوي',
  EQ: 'يساوي',
  NEQ: 'لا يساوي',
};

/** `LINE_COUNT` is a count; everything else is money except the percentage. */
export function fieldUnit(field: ConditionField): 'money' | 'percent' | 'count' {
  if (field === 'LINE_COUNT') return 'count';
  if (field === 'MAX_LINE_DISCOUNT_PERCENT') return 'percent';
  return 'money';
}

/** One clause as a sentence, for the rule list and the approvals inbox. */
export function describeCondition(condition: RuleCondition): string {
  const unit = fieldUnit(condition.field);
  const suffix = unit === 'percent' ? '%' : unit === 'count' ? ' سطر' : '';
  return `${FIELD_LABELS_AR[condition.field]} ${OPERATOR_LABELS_AR[condition.operator]} ${condition.value}${suffix}`;
}
