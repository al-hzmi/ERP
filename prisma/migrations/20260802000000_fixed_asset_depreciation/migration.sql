-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008 — Fixed asset depreciation.
--
-- `fixed_assets` and `depreciation_schedules` have existed since migration 1 with nothing
-- writing to them. A depreciation runner now does, and the invariants it depends on belong
-- here rather than only in the service, for the same reason the ledger's do: an import script,
-- a back-office tool or a developer with `psql` bypasses application code entirely, and an
-- asset whose books are wrong is discovered years later on disposal, as an unexplainable gain
-- or loss with no trail back to the cause.
--
-- `fixed_assets` already carries three guards from migration 2 — cost positive, salvage
-- between zero and cost, useful life positive — and they are left exactly as they are.
-- `depreciation_schedules` had none at all, and no policy either.
--
-- Four things this fixes, in descending order of how much they matter.
--
-- ## 1. `depreciation_schedules` had no row-level security at all
--
-- Migration 004 protects every table carrying a `tenantId`. This table carried none — it
-- was reachable only through its asset — so under `erp_app` it was readable and writable
-- across every tenant in the cluster. One missing `WHERE` in one query over this table was
-- a cross-tenant leak with nothing behind it, which is the precise failure mode migration
-- 004 exists to remove.
--
-- The fix denormalises `tenantId` onto the row so the standard policy applies. A
-- denormalised tenant introduces the risk of a second, disagreeing source of truth, so a
-- trigger refuses any row whose tenant differs from its asset's. It raises rather than
-- silently correcting: a mismatch means calling code has a bug, and quietly rewriting the
-- value would hide it.
--
-- Six sibling tables are in the same position and are NOT addressed here — `fiscal_periods`,
-- `zatca_invoices`, `bank_statement_lines`, `payroll_lines`, `approval_steps` and
-- `approval_actions`. Each is a child of a tenant-scoped parent with no policy of its own.
-- That is a systemic gap deserving its own migration and its own tests, not a footnote to a
-- depreciation feature; it is recorded in README.md under known gaps.
--
-- ## 2. An asset could be depreciated past its salvage value
--
-- Nothing stopped `accumulatedDepreciation` exceeding `acquisitionCost - salvageValue`, and
-- nothing tied `netBookValue` to the other two columns. Both are now checked, which means a
-- runner bug can at worst fail a transaction instead of expensing value the company holds.
--
-- ## 3. A schedule row could claim to be posted with no journal
--
-- `isPosted` and `journalId` were independent. A row posted with no journal is a charge in
-- the asset register that is not in the ledger; a row with a journal but not posted invites
-- a second posting of the same charge. They are now one fact.
--
-- ## 4. There was no index for the runner's only hot query
--
-- "Everything due and unposted for this tenant" was a sequential scan over every schedule
-- row ever generated, on every run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. A tenant on every schedule row ────────────────────────────────────────
--
-- Added nullable, backfilled from the parent, then made NOT NULL. Three statements rather
-- than one because an existing row has no value to default to, and a table this size makes
-- the rewrite cheap.

ALTER TABLE "depreciation_schedules"
    ADD COLUMN IF NOT EXISTS "tenantId" UUID,
    ADD COLUMN IF NOT EXISTS "postedAt" TIMESTAMPTZ(6);

UPDATE "depreciation_schedules" ds
   SET "tenantId" = fa."tenantId"
  FROM "fixed_assets" fa
 WHERE fa."id" = ds."assetId"
   AND ds."tenantId" IS NULL;

-- Orphans cannot exist (the FK to `fixed_assets` is ON DELETE CASCADE), so anything still
-- NULL here would mean the backfill itself failed. Fail loudly rather than deploy a NOT
-- NULL that silently drops nothing.
DO $$
DECLARE
    v_orphans BIGINT;
BEGIN
    SELECT count(*) INTO v_orphans
      FROM "depreciation_schedules" WHERE "tenantId" IS NULL;

    IF v_orphans > 0 THEN
        RAISE EXCEPTION
            '% depreciation schedule row(s) could not be attributed to a tenant', v_orphans;
    END IF;
END;
$$;

ALTER TABLE "depreciation_schedules"
    ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "depreciation_schedules"
    DROP CONSTRAINT IF EXISTS "depreciation_schedules_tenantId_fkey";

ALTER TABLE "depreciation_schedules"
    ADD CONSTRAINT "depreciation_schedules_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "depreciation_schedules"."tenantId" IS
    'Denormalised from the asset so this table can carry its own RLS policy. Kept honest by '
    'depreciation_schedules_tenant_matches_asset(), not by convention.';

-- ── 2. The denormalisation cannot drift ──────────────────────────────────────
--
-- A CHECK constraint cannot read another table, so this is a trigger. It fires on INSERT
-- and on any UPDATE that touches either column, which is the whole surface through which a
-- disagreement could enter.

CREATE OR REPLACE FUNCTION depreciation_schedules_tenant_matches_asset()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_asset_tenant UUID;
BEGIN
    SELECT "tenantId" INTO v_asset_tenant
      FROM "fixed_assets" WHERE "id" = NEW."assetId";

    IF v_asset_tenant IS NULL THEN
        RAISE EXCEPTION 'Fixed asset % does not exist', NEW."assetId"
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW."tenantId" <> v_asset_tenant THEN
        RAISE EXCEPTION
            'Depreciation schedule tenant % does not match asset tenant %',
            NEW."tenantId", v_asset_tenant
            USING ERRCODE = 'raise_exception';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_depreciation_schedules_tenant" ON "depreciation_schedules";

CREATE TRIGGER "trg_depreciation_schedules_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "assetId" ON "depreciation_schedules"
    FOR EACH ROW
    EXECUTE FUNCTION depreciation_schedules_tenant_matches_asset();

-- ── 3. Row-level security, matching migration 004 exactly ────────────────────
--
-- Same fail-closed shape: `erp_current_tenant()` returns NULL when unbound, and
-- `"tenantId" = NULL` is not TRUE, so an unscoped session sees nothing.

ALTER TABLE "depreciation_schedules" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "depreciation_schedules_tenant_isolation" ON "depreciation_schedules";

CREATE POLICY "depreciation_schedules_tenant_isolation" ON "depreciation_schedules"
    FOR ALL
    TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

-- ── 4. A schedule row is arithmetically coherent ─────────────────────────────

ALTER TABLE "depreciation_schedules"
    DROP CONSTRAINT IF EXISTS "depreciation_schedules_non_negative";

ALTER TABLE "depreciation_schedules"
    ADD CONSTRAINT "depreciation_schedules_non_negative"
    CHECK ("amount" >= 0 AND "accumulated" >= 0 AND "netBookValue" >= 0);

COMMENT ON CONSTRAINT "depreciation_schedules_non_negative" ON "depreciation_schedules" IS
    'A negative charge is an appreciation, which is a revaluation entry and not this table.';

-- Posted and journalled are one fact, not two.
ALTER TABLE "depreciation_schedules"
    DROP CONSTRAINT IF EXISTS "depreciation_schedules_posting_complete";

ALTER TABLE "depreciation_schedules"
    ADD CONSTRAINT "depreciation_schedules_posting_complete"
    CHECK (
        ("isPosted" AND "journalId" IS NOT NULL AND "postedAt" IS NOT NULL)
        OR (NOT "isPosted" AND "journalId" IS NULL AND "postedAt" IS NULL)
    );

COMMENT ON CONSTRAINT "depreciation_schedules_posting_complete" ON "depreciation_schedules" IS
    'Posted with no journal is a charge missing from the ledger; journalled but not posted '
    'invites posting the same charge twice.';

-- ── 5. An asset's own columns agree with each other ──────────────────────────
--
-- `netBookValue` is derived from the other two and stored anyway, because every screen
-- reads it and recomputing it per row is a cost paid on every list. Storing a derived value
-- is only safe if the database refuses a disagreeing one.

-- Deliberately NOT re-declared here: `fixed_assets_cost_positive`,
-- `fixed_assets_salvage_valid` and `fixed_assets_useful_life_positive` already exist from
-- migration 2 and say exactly what a depreciation run needs them to say. Restating them under
-- new names would leave two constraints checking one rule, and dropping and re-adding them to
-- merge the wording would churn a working guard for a tidier diff.

ALTER TABLE "fixed_assets"
    DROP CONSTRAINT IF EXISTS "fixed_assets_depreciation_within_bounds";

ALTER TABLE "fixed_assets"
    ADD CONSTRAINT "fixed_assets_depreciation_within_bounds"
    CHECK (
        "accumulatedDepreciation" >= 0
        AND "accumulatedDepreciation" <= "acquisitionCost" - "salvageValue"
    );

COMMENT ON CONSTRAINT "fixed_assets_depreciation_within_bounds" ON "fixed_assets" IS
    'Salvage is the floor by definition. Depreciating past it expenses value the company '
    'still holds, and the excess resurfaces as a phantom gain on disposal.';

ALTER TABLE "fixed_assets"
    DROP CONSTRAINT IF EXISTS "fixed_assets_nbv_derived";

ALTER TABLE "fixed_assets"
    ADD CONSTRAINT "fixed_assets_nbv_derived"
    CHECK ("netBookValue" = "acquisitionCost" - "accumulatedDepreciation");

ALTER TABLE "fixed_assets"
    DROP CONSTRAINT IF EXISTS "fixed_assets_declining_factor_valid";

-- Only meaningful for declining balance; the column keeps its default for straight-line
-- assets and must not constrain them.
ALTER TABLE "fixed_assets"
    ADD CONSTRAINT "fixed_assets_declining_factor_valid"
    CHECK ("method" <> 'DECLINING_BALANCE' OR "decliningFactor" > 1);

COMMENT ON CONSTRAINT "fixed_assets_declining_factor_valid" ON "fixed_assets" IS
    'A factor of 1 is straight line spelled differently; below 1 depreciates slower every '
    'month and never reaches salvage.';

-- ── 6. The runner's index ────────────────────────────────────────────────────
--
-- Leading with `tenantId` because the policy adds that predicate to every query whether the
-- caller wrote it or not, so an index that does not lead with it cannot be used for the
-- lookup. Partial on unposted rows: posted rows are the overwhelming majority within a
-- month of go-live and the runner never looks at them.

DROP INDEX IF EXISTS "depreciation_schedules_due_idx";

CREATE INDEX "depreciation_schedules_due_idx"
    ON "depreciation_schedules" ("tenantId", "periodDate")
    WHERE NOT "isPosted";

-- No separate index by asset: the `(assetId, periodDate)` unique constraint from migration 1
-- already is one, and reading a schedule always leads with the asset.

-- Assets the runner must skip. `disposedAt` is checked in the service too; this makes the
-- skip cheap rather than a filter over every asset ever owned.
CREATE INDEX IF NOT EXISTS "fixed_assets_depreciable_idx"
    ON "fixed_assets" ("tenantId", "acquisitionDate")
    WHERE "disposedAt" IS NULL AND "isActive";

-- ── 7. Proof the guards are installed ────────────────────────────────────────
--
-- A constraint that failed to apply does not break anything visibly — it simply stops
-- refusing what it was added to refuse. Asserting on the catalogue is the only moment
-- anyone would notice.

DO $$
DECLARE
    v_missing TEXT[];
BEGIN
    SELECT array_agg(expected) INTO v_missing
    FROM unnest(ARRAY[
        'depreciation_schedules_non_negative',
        'depreciation_schedules_posting_complete',
        'fixed_assets_depreciation_within_bounds',
        'fixed_assets_nbv_derived',
        'fixed_assets_declining_factor_valid'
    ]) AS expected
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = expected
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Depreciation guards missing: %', array_to_string(v_missing, ', ');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_depreciation_schedules_tenant'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'A schedule row could be attributed to the wrong tenant';
    END IF;

    -- The point of section 3. A table with RLS enabled but no policy denies everything to a
    -- non-owner, which is safe; a table with a policy and RLS disabled denies nothing, which
    -- is the failure this asserts against.
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'depreciation_schedules'
           AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Row-level security is not enabled on depreciation_schedules';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'depreciation_schedules'
           AND qual LIKE '%IS NULL%'
    ) THEN
        RAISE EXCEPTION 'Tenant isolation on depreciation_schedules is fail-open';
    END IF;
END;
$$;
