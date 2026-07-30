import type { JournalType } from '@prisma/client';

/**
 * The journal types a human may raise by hand.
 *
 * The rest of `JournalType` — `SALES`, `PURCHASE`, `CASH`, `INVENTORY`, `PAYROLL`,
 * `DEPRECIATION` — belongs to the use case that derives those entries from a
 * document. Accepting one of them on the manual endpoint would let a hand-written
 * entry impersonate a posted invoice's ledger effect, which is exactly the audit
 * trail this system exists to keep honest. `CLOSING` is excluded too: a year-end
 * close is a process, not a form.
 *
 * Shared by the API route and the entry screen so the list cannot drift into two
 * versions — and because a Next.js route file may only export its HTTP handlers and
 * a fixed set of config fields, so it could not live there even if it wanted to.
 */
export const MANUAL_JOURNAL_TYPES = ['GENERAL', 'ADJUSTMENT', 'OPENING'] as const;

export type ManualJournalType = (typeof MANUAL_JOURNAL_TYPES)[number];

/** Compile-time proof the list stays a subset of the schema's enum. */
const _assertSubset: readonly JournalType[] = MANUAL_JOURNAL_TYPES;
void _assertSubset;

export const MANUAL_JOURNAL_TYPE_LABELS_AR: Record<ManualJournalType, string> = {
  GENERAL: 'قيد عام',
  ADJUSTMENT: 'قيد تسوية',
  OPENING: 'قيد افتتاحي',
};
