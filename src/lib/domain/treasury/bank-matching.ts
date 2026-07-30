import { parseScaled } from '@/lib/domain/shared/scaled-decimal';

/**
 * Deciding which payment a bank statement line refers to.
 *
 * Pure, and separated from the database for the usual reason: this is the part with
 * judgement in it, and judgement is what needs exhaustive tests. Everything the service
 * does around it — reading the statement, writing the match — is mechanical.
 *
 * ## The convention, stated because it is the thing most often got backwards
 *
 * `debit` and `credit` on a statement line follow the **company's** general ledger, not
 * the bank's. A deposit is a **debit**: it increases an asset. Money leaving is a
 * **credit**.
 *
 * This is the opposite of how a bank's own statement paper usually reads, because to the
 * bank your account is a liability and a deposit credits it. The choice here is forced by
 * the schema: `bank_statements.accountId` points at the company's GL account and
 * `openingBalance`/`closingBalance` are that account's balances, so mixing in the bank's
 * mirror convention would put two opposite meanings of "debit" in one row. An importer
 * reading a real bank file is where the flip belongs, and that is the one place it should
 * ever appear.
 *
 * ## What is refused rather than scored
 *
 * Three conditions are absolute, and a candidate failing any of them is not a weak match
 * but no match at all:
 *
 *   - **The amount must be equal to the halala.** A line for 4,999.50 against a payment
 *     of 5,000.00 is not a 90% match; it is a bank charge, a partial settlement or a
 *     different transaction, and every one of those needs a person. Suggesting it invites
 *     someone to reconcile a discrepancy away.
 *   - **The direction must agree.** A deposit cannot be a payment out, whatever the
 *     amount and reference say.
 *   - **The bank account must be the same one.** A payment through another bank cannot
 *     appear on this statement, and a scorer that ignored the account would happily match
 *     two identical transfers made from two accounts on the same day.
 *
 * Only once all three hold does the score say *how confident* the match is, from the
 * evidence that remains: the reference and the date.
 */

export interface StatementLineFacts {
  readonly id: string;
  /** Money into the account. Exactly one of `debit`/`credit` is non-zero. */
  readonly debit: string;
  readonly credit: string;
  readonly valueDate: string;
  readonly description: string;
  readonly reference: string | null;
}

export interface PaymentFacts {
  readonly id: string;
  readonly voucherNumber: string;
  /** `RECEIPT` is money in, `PAYMENT` is money out. */
  readonly type: 'RECEIPT' | 'PAYMENT';
  readonly amount: string;
  readonly paymentDate: string;
  readonly bankReference: string | null;
  readonly checkNumber: string | null;
  readonly counterpartyName: string;
}

export type MatchDirection = 'IN' | 'OUT';

export interface MatchCandidate {
  readonly paymentId: string;
  /** 0..100. Only candidates that cleared every absolute condition appear at all. */
  readonly score: number;
  /** Why, in Arabic, for the person deciding. */
  readonly reasonsAr: readonly string[];
}

/** At or above this, a single unambiguous candidate may be matched without review. */
export const AUTO_MATCH_THRESHOLD = 90;

/** Beyond this many days apart, value date and payment date stop corroborating at all. */
export const MAX_DATE_DISTANCE_DAYS = 7;

/**
 * Which way the money moved, or `null` for a line that is malformed.
 *
 * Both sides populated, or neither, is not something to interpret — it is a broken row,
 * and guessing which side was meant is how a reconciliation ends up reversing a
 * transaction.
 */
export function lineDirection(line: StatementLineFacts): MatchDirection | null {
  const debit = safeScaled(line.debit);
  const credit = safeScaled(line.credit);

  if (debit === null || credit === null) return null;
  if (debit > 0n && credit > 0n) return null;
  if (debit === 0n && credit === 0n) return null;

  return debit > 0n ? 'IN' : 'OUT';
}

/** The absolute value a line moved, as a scale-4 integer, or `null` if malformed. */
export function lineAmount(line: StatementLineFacts): bigint | null {
  const direction = lineDirection(line);
  if (direction === null) return null;

  return direction === 'IN' ? safeScaled(line.debit) : safeScaled(line.credit);
}

function safeScaled(value: string): bigint | null {
  try {
    return parseScaled(value);
  } catch {
    return null;
  }
}

/** Whole days between two ISO dates, absolute. */
function dayDistance(left: string, right: string): number | null {
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;

  return Math.abs(Math.round((a - b) / 86_400_000));
}

/**
 * Normalises a reference for comparison.
 *
 * Bank files are inconsistent about case, spacing and punctuation in a way that has
 * nothing to do with identity: `CHQ 001234`, `chq-001234` and `Chq#001234` are the same
 * cheque. Stripping everything but alphanumerics is what makes a reference comparison
 * about the reference.
 */
export function normaliseReference(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * True when the payment's own reference appears in what the bank wrote.
 *
 * Substring rather than equality, because a bank line description is a sentence with the
 * reference buried in it. Short references are excluded: a three-character token matches
 * inside half the descriptions on a statement, which is a coincidence dressed as
 * evidence.
 */
function referenceAppears(needle: string | null, line: StatementLineFacts): boolean {
  if (needle === null) return false;

  const token = normaliseReference(needle);
  if (token.length < 4) return false;

  const haystack = normaliseReference(`${line.reference ?? ''} ${line.description}`);
  return haystack.includes(token);
}

/**
 * Scores one payment against one line, or returns `null` when it cannot be a match.
 *
 * The scoring floor is 60 rather than 0: a candidate that reaches this function has
 * already proved the same amount, the same direction and the same account, which is
 * substantial agreement on its own. What the reference and the date add is the confidence
 * to act without a human, and only a reference match plus a same-day date gets there.
 */
export function scoreCandidate(
  line: StatementLineFacts,
  payment: PaymentFacts,
): MatchCandidate | null {
  const direction = lineDirection(line);
  const amount = lineAmount(line);
  if (direction === null || amount === null) return null;

  const paid = safeScaled(payment.amount);
  if (paid === null || paid !== amount) return null;

  const expected: MatchDirection = payment.type === 'RECEIPT' ? 'IN' : 'OUT';
  if (expected !== direction) return null;

  const reasonsAr: string[] = ['المبلغ والاتجاه متطابقان'];
  let score = 60;

  if (referenceAppears(payment.bankReference, line)) {
    score += 30;
    reasonsAr.push('المرجع البنكي مذكور في وصف الحركة');
  } else if (referenceAppears(payment.checkNumber, line)) {
    score += 30;
    reasonsAr.push('رقم الشيك مذكور في وصف الحركة');
  } else if (referenceAppears(payment.voucherNumber, line)) {
    score += 25;
    reasonsAr.push('رقم السند مذكور في وصف الحركة');
  }

  const distance = dayDistance(line.valueDate, payment.paymentDate);

  if (distance === null || distance > MAX_DATE_DISTANCE_DAYS) {
    // Not disqualifying: a cheque presented three weeks late is still that cheque. But it
    // stops being evidence, and it should not be auto-matched on amount alone.
    reasonsAr.push('التاريخ بعيد — يحتاج مراجعة');
  } else if (distance === 0) {
    score += 10;
    reasonsAr.push('نفس التاريخ');
  } else {
    // Decays to nothing at the horizon, so "four days apart" earns less than "one".
    score += Math.max(0, Math.round(10 * (1 - distance / MAX_DATE_DISTANCE_DAYS)));
    reasonsAr.push(`فرق ${distance} يوم في التاريخ`);
  }

  return { paymentId: payment.id, score: Math.min(100, score), reasonsAr };
}

/** Every possible match for a line, best first. */
export function rankCandidates(
  line: StatementLineFacts,
  payments: readonly PaymentFacts[],
): MatchCandidate[] {
  return payments
    .map((payment) => scoreCandidate(line, payment))
    .filter((candidate): candidate is MatchCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score);
}

/**
 * The one candidate safe to match automatically, or `null`.
 *
 * Two conditions, and the second is the one that matters. A candidate must clear the
 * threshold *and* be unambiguous: if two payments score equally well, the evidence does
 * not distinguish them, and picking the first is a coin toss recorded as a reconciliation.
 * Two identical transfers to the same supplier on the same day is not a rare case — it is
 * Tuesday — and that is precisely when an automatic matcher must decline and ask.
 */
export function unambiguousAutoMatch(
  line: StatementLineFacts,
  payments: readonly PaymentFacts[],
): MatchCandidate | null {
  const ranked = rankCandidates(line, payments);

  const best = ranked[0];
  if (best === undefined || best.score < AUTO_MATCH_THRESHOLD) return null;

  const runnerUp = ranked[1];
  if (runnerUp !== undefined && runnerUp.score === best.score) return null;

  return best;
}
