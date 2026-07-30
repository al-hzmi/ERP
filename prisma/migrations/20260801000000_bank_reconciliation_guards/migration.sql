-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007 — Guards for bank reconciliation.
--
-- `bank_statements` and `bank_statement_lines` have existed since migration 1 with no
-- constraints and nothing writing to them. Now that a reconciliation screen writes to
-- them, the invariants it depends on belong in the database — for the same reason the
-- ledger's do: application code can be bypassed by an import script, a back-office tool,
-- or a developer with `psql`, and a reconciliation that is wrong is worse than one that
-- has not been done, because it has been signed off.
--
-- ## The debit/credit convention, fixed here
--
-- `debit` is money *into* the account and `credit` is money out, following the company's
-- general ledger. This is the opposite of how a bank's own statement paper reads — to the
-- bank your account is a liability, so a deposit credits it — and the choice is forced:
-- `accountId` points at the company's GL account and `openingBalance`/`closingBalance` are
-- that account's balances. Mixing the bank's mirror convention into the same row would put
-- two opposite meanings of "debit" in one table. The flip belongs in an importer reading a
-- real bank file, and nowhere else.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. A statement line moves money one way ──────────────────────────────────
--
-- Both sides populated is not a row to interpret. Neither side populated is not a
-- transaction. Either one reaching the matcher would make it guess, and a guess here
-- reverses a transaction.

ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_single_sided"
    CHECK (
        ("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0)
    );

ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_non_negative"
    CHECK ("debit" >= 0 AND "credit" >= 0);

-- ── 2. A match is complete or absent, never half-written ─────────────────────
--
-- `matchedPaymentId` without `matchedAt` is a match with no audit trail; `matchedAt`
-- without a payment is an audit trail for nothing. Both states are reachable from a
-- partial `UPDATE`, and both make the reconciliation summary lie about what is matched.

ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_match_complete"
    CHECK (
        ("matchedPaymentId" IS NULL AND "matchedAt" IS NULL AND "matchScore" IS NULL)
        OR ("matchedPaymentId" IS NOT NULL AND "matchedAt" IS NOT NULL AND "matchScore" IS NOT NULL)
    );

ALTER TABLE "bank_statement_lines"
    ADD CONSTRAINT "bank_statement_lines_score_range"
    CHECK ("matchScore" IS NULL OR ("matchScore" >= 0 AND "matchScore" <= 100));

-- ── 3. One payment clears once ───────────────────────────────────────────────
--
-- The constraint that does the real work. A payment matched to two statement lines has
-- been reconciled twice, which makes the bank balance appear to agree with the books while
-- concealing a genuine unexplained difference — the exact failure a reconciliation exists
-- to surface.
--
-- Partial, so the many unmatched lines (all NULL) do not collide with each other.

CREATE UNIQUE INDEX "bank_statement_lines_one_match_per_payment_idx"
    ON "bank_statement_lines" ("matchedPaymentId")
    WHERE "matchedPaymentId" IS NOT NULL;

-- The screen's main query: this statement's lines, unmatched first.
CREATE INDEX "bank_statement_lines_unmatched_idx"
    ON "bank_statement_lines" ("bankStatementId", "valueDate")
    WHERE "matchedPaymentId" IS NULL;

-- ── 4. A statement covers a period, in order ─────────────────────────────────

ALTER TABLE "bank_statements"
    ADD CONSTRAINT "bank_statements_period_ordered"
    CHECK ("periodEnd" >= "periodStart");

-- ── 5. Who signed it off, and when ───────────────────────────────────────────
--
-- `isReconciled` records that someone concluded the statement agrees with the books. That
-- is an assertion a person made, and an assertion with no name against it is one nobody
-- can be asked about. Every other consequential state change in this schema carries its
-- actor; this one was the exception.

ALTER TABLE "bank_statements"
    ADD COLUMN "reconciledAt" TIMESTAMPTZ(6),
    ADD COLUMN "reconciledById" UUID;

ALTER TABLE "bank_statements"
    ADD CONSTRAINT "bank_statements_reconciledById_fkey"
    FOREIGN KEY ("reconciledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statements"
    ADD CONSTRAINT "bank_statements_reconciliation_complete"
    CHECK (
        ("isReconciled" = false AND "reconciledAt" IS NULL AND "reconciledById" IS NULL)
        OR ("isReconciled" = true AND "reconciledAt" IS NOT NULL AND "reconciledById" IS NOT NULL)
    );

COMMENT ON COLUMN "bank_statements"."isReconciled" IS
    'A person asserted that this statement agrees with the ledger. See reconciledById.';

-- ── 6. Proof the guards are installed ────────────────────────────────────────
--
-- A CHECK constraint that failed to apply does not break anything visibly — it simply
-- stops refusing what it was added to refuse. Asserting on the catalogue is the only
-- moment anyone would notice.

DO $$
DECLARE
    v_missing TEXT[];
BEGIN
    SELECT array_agg(expected) INTO v_missing
    FROM unnest(ARRAY[
        'bank_statement_lines_single_sided',
        'bank_statement_lines_non_negative',
        'bank_statement_lines_match_complete',
        'bank_statement_lines_score_range',
        'bank_statements_period_ordered',
        'bank_statements_reconciliation_complete'
    ]) AS expected
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = expected
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Bank reconciliation guards missing: %', array_to_string(v_missing, ', ');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'bank_statement_lines_one_match_per_payment_idx'
    ) THEN
        RAISE EXCEPTION 'A payment could be matched to two statement lines';
    END IF;
END;
$$;
