-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014 — Customer credit profiles, and the facts a credit rule asks about.
--
-- ## What was already here, and is therefore not added again
--
-- `documents.dueDate` has existed since migration 1. `counterparties.creditLimit` has too,
-- and it is field-protected — it appears only for a caller holding the `creditLimit` grant.
-- `getAgingReport` already buckets receivables into 0-30 / 31-60 / 61-90 / 90+ in SQL.
--
-- So this migration adds the one thing that genuinely did not exist: the *policy* per
-- customer — how long past due before the system stops selling to them, and how many days of
-- grace they get before an invoice counts as late at all.
--
-- ## Why the profile does not carry a second `creditLimit`
--
-- It was asked for, and it would be a mistake. `counterparties.creditLimit` already exists and
-- is read by the ageing report, the customer card and the field-level permission set. A second
-- column holding the same concept means every screen has to decide which one wins, and the two
-- will disagree the first time somebody updates one of them — silently, because nothing would
-- flag it. The profile therefore holds the *terms* (grace, hold threshold, block flag) and the
-- limit stays where the rest of the system already looks for it.
--
-- ## Grace days are not payment terms
--
-- `payment_terms.netDays` (migration 011) decides when an invoice *becomes* due. `graceDays`
-- here decides how long after that the company is willing to wait before treating it as
-- delinquent. They are different decisions made by different people — the first is negotiated
-- with the customer, the second is set by whoever owns collections — and collapsing them means
-- extending a customer's terms every time you soften your dunning.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "customer_credit_profiles" (
    "id"               UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"         UUID NOT NULL,
    "counterpartyId"   UUID NOT NULL,
    -- Days after the due date before an invoice is treated as delinquent. Zero means the day
    -- after it is due, which is what a company with no grace policy actually means.
    "graceDays"        INTEGER NOT NULL DEFAULT 0,
    -- The age at which the system stops letting a new order through unreviewed. Separate from
    -- `graceDays` because "late" and "too late to keep selling" are different judgements.
    "holdAfterDays"    INTEGER NOT NULL DEFAULT 60,
    -- A manual override that outranks every calculation: a customer in dispute or in
    -- liquidation is blocked regardless of what the numbers say.
    "isBlocked"        BOOLEAN NOT NULL DEFAULT false,
    "blockReason"      VARCHAR(512),
    "notes"            VARCHAR(1024),
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "customer_credit_profiles_pkey" PRIMARY KEY ("id")
);

-- One profile per counterparty. Two would be two policies for one customer, and whichever the
-- query returned first would decide whether the company keeps selling to them.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_credit_profiles_counterpartyId_key"
    ON "customer_credit_profiles" ("counterpartyId");

CREATE INDEX IF NOT EXISTS "customer_credit_profiles_tenantId_idx"
    ON "customer_credit_profiles" ("tenantId");

ALTER TABLE "customer_credit_profiles"
    DROP CONSTRAINT IF EXISTS "customer_credit_profiles_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "customer_credit_profiles_counterpartyId_fkey";

ALTER TABLE "customer_credit_profiles"
    ADD CONSTRAINT "customer_credit_profiles_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Cascade: a profile is an attribute of the customer and has no meaning without them.
    ADD CONSTRAINT "customer_credit_profiles_counterpartyId_fkey" FOREIGN KEY ("counterpartyId")
        REFERENCES "counterparties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_credit_profiles"
    DROP CONSTRAINT IF EXISTS "customer_credit_profiles_days_sane",
    DROP CONSTRAINT IF EXISTS "customer_credit_profiles_block_explained";

ALTER TABLE "customer_credit_profiles"
    ADD CONSTRAINT "customer_credit_profiles_days_sane"
        CHECK (
            "graceDays" >= 0 AND "graceDays" <= 365
        AND "holdAfterDays" >= 0 AND "holdAfterDays" <= 3650
        -- Holding *before* the grace period expires would stop sales to a customer the
        -- company has explicitly agreed not to chase yet.
        AND "holdAfterDays" >= "graceDays"
        ),
    -- A block with no stated reason is one nobody can lift, because nobody knows what would
    -- resolve it.
    ADD CONSTRAINT "customer_credit_profiles_block_explained"
        CHECK (NOT "isBlocked" OR ("blockReason" IS NOT NULL AND length(btrim("blockReason")) > 0));

DROP TRIGGER IF EXISTS "trg_customer_credit_profiles_tenant" ON "customer_credit_profiles";
CREATE TRIGGER "trg_customer_credit_profiles_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "counterpartyId" ON "customer_credit_profiles"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('counterparties', 'counterpartyId');

ALTER TABLE "customer_credit_profiles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_credit_profiles_tenant_isolation" ON "customer_credit_profiles";
CREATE POLICY "customer_credit_profiles_tenant_isolation" ON "customer_credit_profiles"
    FOR ALL TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_credit_profiles" TO erp_app;

-- ── The index the collections dashboard lives on ─────────────────────────────
--
-- Every query in `collections-service` filters open receivables by due date. Without this the
-- dashboard is a sequential scan of `documents` — which is partitioned, so it is a sequential
-- scan of every partition.
--
-- Partial, because a fully paid invoice is never on this report and indexing it is write cost
-- for a row the query will never look at.
CREATE INDEX IF NOT EXISTS "documents_open_receivable_idx"
    ON "documents" ("tenantId", "counterpartyId", "dueDate")
    WHERE "total" > "paidAmount";

-- ── New condition fields for the approval engine ─────────────────────────────
--
-- Migration 013 built the rule engine over facts drawn from the document itself. Credit
-- control asks about the *counterparty*, which is the whole point of the integration: "block a
-- sales order for a customer more than 60 days overdue" is not a fact about the order.
--
-- Added to the existing enum rather than to a parallel one, so a single rule can mix them —
-- "total over 50,000 AND overdue over 60 days" is one rule, evaluated once.
--
-- **Only added here, never used here.** PostgreSQL refuses to reference a new enum value from
-- the transaction that created it (`unsafe use of new value ... must be committed first`), and
-- Prisma runs each migration in one transaction. Migration 013's own header warned about this
-- and this migration hit it anyway on the first deploy — the CHECK constraint that mentions
-- `OVERDUE_DAYS` lives in migration 015 for exactly that reason.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'ApprovalConditionField' AND e.enumlabel = 'OVERDUE_DAYS'
    ) THEN
        ALTER TYPE "ApprovalConditionField" ADD VALUE 'OVERDUE_DAYS';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'ApprovalConditionField' AND e.enumlabel = 'OVERDUE_AMOUNT'
    ) THEN
        ALTER TYPE "ApprovalConditionField" ADD VALUE 'OVERDUE_AMOUNT';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'ApprovalConditionField' AND e.enumlabel = 'CREDIT_EXPOSURE_PERCENT'
    ) THEN
        ALTER TYPE "ApprovalConditionField" ADD VALUE 'CREDIT_EXPOSURE_PERCENT';
    END IF;
END;
$$;

-- ── Proof ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'customer_credit_profiles' AND c.relrowsecurity
    ) THEN
        v_missing := v_missing || 'RLS disabled on customer_credit_profiles';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'customer_credit_profiles'
           AND policyname = 'customer_credit_profiles_tenant_isolation'
           AND qual LIKE '%erp_current_tenant%' AND with_check LIKE '%erp_current_tenant%'
    ) THEN
        v_missing := v_missing || 'policy absent or incomplete';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_customer_credit_profiles_tenant' AND NOT tgisinternal
    ) THEN
        v_missing := v_missing || 'tenant guard trigger absent';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_open_receivable_idx') THEN
        v_missing := v_missing || 'the collections index is missing';
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 014 incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;
