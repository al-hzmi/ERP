-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013 — Conditions on approval policies, and a status for documents held by one.
--
-- ## Why this extends `approval_policies` instead of adding an `approval_rules` table
--
-- A separate rules table was the obvious reading of the request, and it would have been a
-- second approval engine standing next to the one that already works. `approval_policies`
-- *is* a rule: `documentType + minAmount` is a condition, just one of fixed shape. Everything
-- downstream of it — the ordered `approval_steps`, the one-request-per-entity constraint on
-- `approval_requests`, the segregation-of-duties check, the SERIALIZABLE decision path that
-- stops two approvers advancing the same step, and the inbox that reads it — is written
-- against a policy id.
--
-- A parallel table would need its own copy of all of that, or a second inbox, and the two
-- would drift on exactly the question that matters: which one decides. So `minAmount` becomes
-- one row in a general condition set, and the rest of the engine does not change at all.
--
-- ## What a condition is
--
-- One row: a field of the document, a comparison, and a number. A policy's conditions are
-- ANDed — "total over 50,000 **and** discount over 15%" is two rows, and that is the reading
-- people expect when they add a second line to a rule. OR is expressed by writing two
-- policies, which also makes the two reasons distinguishable in the audit trail.
--
-- A policy with no conditions applies to every document of its type. That is deliberate and it
-- is the common first rule somebody writes ("all purchase orders need the manager").
--
-- ## The document status
--
-- `TradeDocumentStatus` gains `PENDING_APPROVAL`. It sits between DRAFT and CONFIRMED because
-- that is where the interception happens: a draft commits nothing and needs no approval, while
-- confirming is the act that binds the company to a counterparty. Holding at *create* would
-- put every half-typed order in somebody's inbox.
--
-- Lines stay frozen in PENDING_APPROVAL — migration 011's trigger already freezes anything
-- that is not DRAFT, and a document being reviewed is precisely one whose terms must not move
-- under the reviewer. A rejection returns it to DRAFT, which unfreezes it so it can be revised
-- and resubmitted; that is why rejection does not cancel.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Enum additions ───────────────────────────────────────────────────────────
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in PostgreSQL below 12 and
-- cannot be used in the same statement that references the new value. Prisma runs each
-- migration in a transaction, so the value is added first and used only by later migrations
-- and by application code — never in this file.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'TradeDocumentStatus' AND e.enumlabel = 'PENDING_APPROVAL'
    ) THEN
        ALTER TYPE "TradeDocumentStatus" ADD VALUE 'PENDING_APPROVAL' AFTER 'DRAFT';
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApprovalConditionField') THEN
        CREATE TYPE "ApprovalConditionField" AS ENUM (
            'TOTAL_AMOUNT',
            'SUBTOTAL',
            'TAX_AMOUNT',
            'LINE_COUNT',
            'MAX_LINE_DISCOUNT_PERCENT'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApprovalConditionOperator') THEN
        CREATE TYPE "ApprovalConditionOperator" AS ENUM ('GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ');
    END IF;
END;
$$;

-- ── Naming and ordering on the policy ────────────────────────────────────────
--
-- A rule the administrator wrote needs a name they recognise in a list, and the request that
-- it raised needs to say which rule raised it. Without one the approvals inbox can only say
-- "a policy matched", which is not something anybody can act on or argue with.

ALTER TABLE "approval_policies"
    ADD COLUMN IF NOT EXISTS "nameAr"   VARCHAR(128),
    ADD COLUMN IF NOT EXISTS "nameEn"   VARCHAR(128),
    -- Lower runs first. When several rules match one document the strictest should win, and
    -- "strictest" is a judgement the administrator makes, not one the amount can express.
    ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- Backfill before the NOT NULL, or every existing policy fails the constraint. The demo seed
-- creates policies with no name, and so did every deployment before this migration.
UPDATE "approval_policies"
   SET "nameAr" = COALESCE("nameAr", 'اعتماد ' || "documentType" || ' من ' || "minAmount"::text),
       "nameEn" = COALESCE("nameEn", "documentType" || ' over ' || "minAmount"::text)
 WHERE "nameAr" IS NULL OR "nameEn" IS NULL;

ALTER TABLE "approval_policies"
    ALTER COLUMN "nameAr" SET NOT NULL,
    ALTER COLUMN "nameEn" SET NOT NULL;

-- The old unique was `(tenantId, documentType, minAmount)`, which made sense when the amount
-- *was* the rule. With general conditions two rules on one document type at the same amount
-- are ordinary — "over 50,000" and "over 50,000 with a discount above 15%" — so uniqueness
-- moves to the name, which is what an administrator actually needs to be unambiguous.
ALTER TABLE "approval_policies"
    DROP CONSTRAINT IF EXISTS "approval_policies_tenantId_documentType_minAmount_key";

DROP INDEX IF EXISTS "approval_policies_tenantId_documentType_minAmount_key";

CREATE UNIQUE INDEX IF NOT EXISTS "approval_policies_tenantId_nameAr_key"
    ON "approval_policies" ("tenantId", "nameAr");

CREATE INDEX IF NOT EXISTS "approval_policies_tenantId_documentType_idx"
    ON "approval_policies" ("tenantId", "documentType", "priority");

-- ── Conditions ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "approval_rule_conditions" (
    "id"       UUID NOT NULL DEFAULT uuid_generate_v4(),
    -- Denormalised from the policy so this table carries a policy of its own, kept honest by
    -- migration 009's generic guard. Same arrangement as every other child table here.
    "tenantId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "field"    "ApprovalConditionField" NOT NULL,
    "operator" "ApprovalConditionOperator" NOT NULL,
    -- Scale 4 to match every money column in the schema. A percentage lives here too: 15%
    -- is stored as 15, not 0.15, because that is what the administrator typed.
    "value"    DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "approval_rule_conditions_pkey" PRIMARY KEY ("id")
);

-- One condition per field per policy. Two rows on `TOTAL_AMOUNT` would be ANDed into a range
-- the builder cannot express and the reader cannot see — "> 50000 AND < 10000" is a rule that
-- silently never fires.
CREATE UNIQUE INDEX IF NOT EXISTS "approval_rule_conditions_policyId_field_key"
    ON "approval_rule_conditions" ("policyId", "field");

CREATE INDEX IF NOT EXISTS "approval_rule_conditions_tenantId_idx"
    ON "approval_rule_conditions" ("tenantId");
CREATE INDEX IF NOT EXISTS "approval_rule_conditions_tenantId_policyId_idx"
    ON "approval_rule_conditions" ("tenantId", "policyId");

ALTER TABLE "approval_rule_conditions"
    DROP CONSTRAINT IF EXISTS "approval_rule_conditions_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "approval_rule_conditions_policyId_fkey";

ALTER TABLE "approval_rule_conditions"
    ADD CONSTRAINT "approval_rule_conditions_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Cascade: a condition has no meaning without its rule, and an orphan would be a rule
    -- fragment nothing can reach and nothing will clean up.
    ADD CONSTRAINT "approval_rule_conditions_policyId_fkey" FOREIGN KEY ("policyId")
        REFERENCES "approval_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval_rule_conditions"
    DROP CONSTRAINT IF EXISTS "approval_rule_conditions_value_sane";

-- Counts and percentages cannot be negative, and neither can any amount this compares
-- against. A negative threshold is a rule that fires on everything, written by accident.
ALTER TABLE "approval_rule_conditions"
    ADD CONSTRAINT "approval_rule_conditions_value_sane"
    CHECK (
        "value" >= 0
    AND ("field" <> 'MAX_LINE_DISCOUNT_PERCENT' OR "value" <= 100)
    AND ("field" <> 'LINE_COUNT' OR "value" = trunc("value"))
    );

DROP TRIGGER IF EXISTS "trg_approval_rule_conditions_tenant" ON "approval_rule_conditions";
CREATE TRIGGER "trg_approval_rule_conditions_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "policyId" ON "approval_rule_conditions"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('approval_policies', 'policyId');

-- ── Row-level security ───────────────────────────────────────────────────────

ALTER TABLE "approval_rule_conditions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "approval_rule_conditions_tenant_isolation" ON "approval_rule_conditions";
CREATE POLICY "approval_rule_conditions_tenant_isolation" ON "approval_rule_conditions"
    FOR ALL TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_rule_conditions" TO erp_app;

-- ── Which rule raised the request ────────────────────────────────────────────
--
-- `approval_requests.policyId` already records it. What it does not record is *why* — the
-- facts as they stood when the rule fired. Storing them makes the request explicable a year
-- later, when the rule has been edited and the document has been revised, and neither can be
-- replayed to reconstruct the decision.

ALTER TABLE "approval_requests"
    ADD COLUMN IF NOT EXISTS "triggeredBy" JSONB;

COMMENT ON COLUMN "approval_requests"."triggeredBy" IS
    'The facts that satisfied the rule at the instant it fired, and the conditions it matched. '
    'Kept because the rule and the document can both change afterwards, and without this the '
    'request cannot be explained once either does.';

-- ── Proof ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'approval_rule_conditions' AND c.relrowsecurity
    ) THEN
        v_missing := v_missing || 'RLS disabled on approval_rule_conditions';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'approval_rule_conditions'
           AND policyname = 'approval_rule_conditions_tenant_isolation'
           AND qual LIKE '%erp_current_tenant%' AND with_check LIKE '%erp_current_tenant%'
    ) THEN
        v_missing := v_missing || 'policy absent or incomplete on approval_rule_conditions';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_approval_rule_conditions_tenant' AND NOT tgisinternal
    ) THEN
        v_missing := v_missing || 'tenant guard trigger absent';
    END IF;

    -- Every policy must be nameable, or the inbox cannot say what held the document.
    IF EXISTS (SELECT 1 FROM "approval_policies" WHERE "nameAr" IS NULL OR "nameEn" IS NULL) THEN
        v_missing := v_missing || 'a policy has no name after backfill';
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 013 incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;
