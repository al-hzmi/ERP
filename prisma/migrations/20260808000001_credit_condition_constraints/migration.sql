-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015 — The CHECK that references migration 014's new enum values.
--
-- Its own file for one reason, and it is a PostgreSQL rule rather than a style choice: a new
-- enum value cannot be *referenced* by the transaction that added it —
--
--   ERROR: unsafe use of new value "OVERDUE_DAYS" of enum type "ApprovalConditionField"
--   HINT:  New enum values must be committed before they can be used.
--
-- Prisma wraps each migration in a transaction, so `ALTER TYPE ... ADD VALUE` and any
-- constraint naming that value must be two migrations. Migration 013's header noted this and
-- migration 014 was written ignoring it; this is the split that fixes it.
--
-- ## What the constraint says, and what it deliberately does not
--
-- `OVERDUE_DAYS` is a whole number of days: a rule reading "overdue by more than 60.5 days" is
-- a typo, and the column is DECIMAL(19,4) so nothing else would catch it.
--
-- `CREDIT_EXPOSURE_PERCENT` gets **no ceiling**, unlike `MAX_LINE_DISCOUNT_PERCENT`. A customer
-- at 300% of their credit limit is a real and important number — capping it at 100 would make
-- the most alarming rules in the system unwritable.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "approval_rule_conditions"
    DROP CONSTRAINT IF EXISTS "approval_rule_conditions_value_sane";

ALTER TABLE "approval_rule_conditions"
    ADD CONSTRAINT "approval_rule_conditions_value_sane"
    CHECK (
        "value" >= 0
    AND ("field" <> 'MAX_LINE_DISCOUNT_PERCENT' OR "value" <= 100)
    AND ("field" <> 'LINE_COUNT'   OR "value" = trunc("value"))
    AND ("field" <> 'OVERDUE_DAYS' OR "value" = trunc("value"))
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'approval_rule_conditions_value_sane'
    ) THEN
        RAISE EXCEPTION 'The condition value constraint was not installed';
    END IF;
END;
$$;
