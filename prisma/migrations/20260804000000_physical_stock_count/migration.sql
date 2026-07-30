-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010 — Physical stock count.
--
-- The first migration written *after* migration 009's deploy assertion existed, and it is a
-- useful proof of it: adding these two tables without their policies would have failed the
-- next `migrate deploy` with the table names in the error. The assertion is not decoration.
--
-- ## Why a count needs tables at all
--
-- A physical count could, naively, be a screen that compares typed quantities against
-- `stock_levels` at the moment someone presses save. That produces variances that are
-- arithmetic artefacts: stock moves while people are counting, so a line counted at 09:00 and
-- saved at 16:00 is compared against a balance that absorbed a whole day of sales. The
-- warehouse manager then cannot tell an artefact from a real loss, and the count — whose
-- entire purpose is to find real losses — becomes noise.
--
-- So `expectedQuantity` is written when the sheet is *opened* and never recomputed. A variance
-- is then a statement about a specific instant, which is what makes it evidence.
--
-- `unitCostAtOpen` is frozen for the same reason: valuing a shortage at a cost that moved
-- after the count began prices the loss at something the company never held.
--
-- ## `countedQuantity` is nullable and zero is not null
--
-- A shelf that is empty is a count of zero and a real finding — very often the most important
-- one. A line nobody reached is unknown. Collapsing them into one column with zero as the
-- default would silently convert every uncounted line into a total write-off at finalisation.
-- ─────────────────────────────────────────────────────────────────────────────

-- The status is a native enum, not TEXT with a CHECK. Prisma maps a schema enum to a
-- PostgreSQL type and its client casts to it by name, so a TEXT column type-checks in the
-- schema and fails at runtime with `type "public"."StockCountStatus" does not exist` — which
-- is exactly what happened when this migration first ran.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StockCountStatus') THEN
        CREATE TYPE "StockCountStatus" AS ENUM ('COUNTING', 'COMPLETED', 'CANCELLED');
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS "stock_counts" (
    "id"            UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"      UUID NOT NULL,
    "countNumber"   VARCHAR(32) NOT NULL,
    "warehouseId"   UUID NOT NULL,
    "branchId"      UUID NOT NULL,
    "status"        "StockCountStatus" NOT NULL DEFAULT 'COUNTING',
    "countDate"     DATE NOT NULL,
    "notes"         VARCHAR(512),
    "openedById"    UUID NOT NULL,
    "openedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "finalisedById" UUID,
    "finalisedAt"   TIMESTAMPTZ(6),
    "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stock_count_lines" (
    "id"                   UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"             UUID NOT NULL,
    "countId"              UUID NOT NULL,
    "productId"            UUID NOT NULL,
    "expectedQuantity"     DECIMAL(19,4) NOT NULL,
    "countedQuantity"      DECIMAL(19,4),
    "unitCostAtOpen"       DECIMAL(19,4) NOT NULL,
    "adjustmentMovementId" UUID,
    "countedById"          UUID,
    "countedAt"            TIMESTAMPTZ(6),

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- ── Keys and indexes ─────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "stock_counts_tenantId_countNumber_key"
    ON "stock_counts" ("tenantId", "countNumber");

-- The register's query, and the one the "is a sheet already open here" check uses.
CREATE INDEX IF NOT EXISTS "stock_counts_tenantId_warehouseId_status_idx"
    ON "stock_counts" ("tenantId", "warehouseId", "status");

-- A product appears at most once on a sheet. Two lines for one product would let a counter
-- record 40 on one and 0 on the other, and finalisation would post both.
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_lines_countId_productId_key"
    ON "stock_count_lines" ("countId", "productId");

CREATE INDEX IF NOT EXISTS "stock_count_lines_tenantId_countId_idx"
    ON "stock_count_lines" ("tenantId", "countId");

-- Leading with the policy's own predicate, as migration 009 established.
CREATE INDEX IF NOT EXISTS "stock_counts_tenantId_idx" ON "stock_counts" ("tenantId");
CREATE INDEX IF NOT EXISTS "stock_count_lines_tenantId_idx" ON "stock_count_lines" ("tenantId");

-- ── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE "stock_counts"
    DROP CONSTRAINT IF EXISTS "stock_counts_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "stock_counts_warehouseId_fkey",
    DROP CONSTRAINT IF EXISTS "stock_counts_branchId_fkey";

ALTER TABLE "stock_counts"
    ADD CONSTRAINT "stock_counts_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "stock_counts_warehouseId_fkey" FOREIGN KEY ("warehouseId")
        REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "stock_counts_branchId_fkey" FOREIGN KEY ("branchId")
        REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_count_lines"
    DROP CONSTRAINT IF EXISTS "stock_count_lines_tenantId_fkey",
    DROP CONSTRAINT IF EXISTS "stock_count_lines_countId_fkey",
    DROP CONSTRAINT IF EXISTS "stock_count_lines_productId_fkey";

ALTER TABLE "stock_count_lines"
    ADD CONSTRAINT "stock_count_lines_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Cascade: a cancelled sheet's lines have no meaning without it. The ledger is untouched
    -- either way, because a cancelled sheet posts nothing.
    ADD CONSTRAINT "stock_count_lines_countId_fkey" FOREIGN KEY ("countId")
        REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "stock_count_lines_productId_fkey" FOREIGN KEY ("productId")
        REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── CHECK constraints ────────────────────────────────────────────────────────

-- No CHECK on `status`: the enum type already refuses anything outside its three values, and
-- a second copy of that rule would be a weaker one to keep in step.
ALTER TABLE "stock_counts"
    DROP CONSTRAINT IF EXISTS "stock_counts_finalisation_complete";

-- Finalised is one fact, not three columns that can disagree. A sheet marked COMPLETED with
-- no `finalisedAt` has no record of who signed off on writing stock away.
ALTER TABLE "stock_counts"
    ADD CONSTRAINT "stock_counts_finalisation_complete"
    CHECK (
        ("status" = 'COUNTING'  AND "finalisedAt" IS NULL     AND "finalisedById" IS NULL)
     OR ("status" = 'COMPLETED' AND "finalisedAt" IS NOT NULL AND "finalisedById" IS NOT NULL)
     OR ("status" = 'CANCELLED' AND "finalisedAt" IS NOT NULL AND "finalisedById" IS NOT NULL)
    );

ALTER TABLE "stock_count_lines"
    DROP CONSTRAINT IF EXISTS "stock_count_lines_quantities_sane",
    DROP CONSTRAINT IF EXISTS "stock_count_lines_counting_complete";

-- A counted quantity may be zero — an empty shelf is a finding — but never negative: you
-- cannot count minus three of something.
ALTER TABLE "stock_count_lines"
    ADD CONSTRAINT "stock_count_lines_quantities_sane"
    CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);

-- A counted line records who counted it and when. Without that the sheet cannot be audited,
-- which is most of why a count is documented at all.
ALTER TABLE "stock_count_lines"
    ADD CONSTRAINT "stock_count_lines_counting_complete"
    CHECK (
        ("countedQuantity" IS NULL     AND "countedById" IS NULL     AND "countedAt" IS NULL)
     OR ("countedQuantity" IS NOT NULL AND "countedById" IS NOT NULL AND "countedAt" IS NOT NULL)
    );

COMMENT ON COLUMN "stock_count_lines"."expectedQuantity" IS
    'The balance frozen at the instant the sheet opened. Never recomputed: a variance against a '
    'balance that moved during counting is an arithmetic artefact, not a finding.';

COMMENT ON COLUMN "stock_count_lines"."countedQuantity" IS
    'NULL means nobody reached this line. Zero means the shelf was empty, which is a finding.';

-- ── The frozen sheet stays frozen ────────────────────────────────────────────
--
-- `expectedQuantity` and `unitCostAtOpen` are the whole point of the table. A trigger refuses
-- to change them after insert, so "freezing" is a property of the database rather than a
-- convention the service is trusted to keep.
--
-- It also refuses any edit to a line whose sheet is no longer COUNTING: a finalised count is
-- evidence, and evidence that can be revised after the adjustments posted is not evidence.

CREATE OR REPLACE FUNCTION erp_stock_count_line_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_status TEXT;
BEGIN
    IF NEW."expectedQuantity" IS DISTINCT FROM OLD."expectedQuantity"
       OR NEW."unitCostAtOpen" IS DISTINCT FROM OLD."unitCostAtOpen" THEN
        RAISE EXCEPTION
            'The expected quantity and opening cost of a count line are frozen at open'
            USING ERRCODE = 'ERP12';
    END IF;

    SELECT "status" INTO v_status FROM "stock_counts" WHERE "id" = NEW."countId";

    IF v_status <> 'COUNTING' THEN
        RAISE EXCEPTION 'Stock count % is % and can no longer be edited', NEW."countId", v_status
            USING ERRCODE = 'ERP12';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_stock_count_lines_immutability" ON "stock_count_lines";

CREATE TRIGGER "trg_stock_count_lines_immutability"
    BEFORE UPDATE ON "stock_count_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_stock_count_line_immutability();

-- ── The tenant cannot drift from the parent ──────────────────────────────────
--
-- Reusing migration 009's generic guard rather than writing a third copy of it. A line's tenant
-- must equal its sheet's; a sheet's must equal its warehouse's.

DROP TRIGGER IF EXISTS "trg_stock_count_lines_tenant" ON "stock_count_lines";
CREATE TRIGGER "trg_stock_count_lines_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "countId" ON "stock_count_lines"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('stock_counts', 'countId');

DROP TRIGGER IF EXISTS "trg_stock_counts_tenant" ON "stock_counts";
CREATE TRIGGER "trg_stock_counts_tenant"
    BEFORE INSERT OR UPDATE OF "tenantId", "warehouseId" ON "stock_counts"
    FOR EACH ROW
    EXECUTE FUNCTION erp_child_tenant_matches_parent('warehouses', 'warehouseId');

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- The same fail-closed shape as every other table. Without these two blocks the assertion at
-- the foot of migration 009 fails the deploy and names both tables.

ALTER TABLE "stock_counts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stock_counts_tenant_isolation" ON "stock_counts";
CREATE POLICY "stock_counts_tenant_isolation" ON "stock_counts"
    FOR ALL TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

ALTER TABLE "stock_count_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stock_count_lines_tenant_isolation" ON "stock_count_lines";
CREATE POLICY "stock_count_lines_tenant_isolation" ON "stock_count_lines"
    FOR ALL TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

-- ── Proof ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    t         TEXT;
    v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
    FOREACH t IN ARRAY ARRAY['stock_counts', 'stock_count_lines'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity
        ) THEN
            v_missing := v_missing || (t || ': RLS disabled');
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = t
               AND policyname = t || '_tenant_isolation'
               AND qual LIKE '%erp_current_tenant%'
               AND with_check LIKE '%erp_current_tenant%'
        ) THEN
            v_missing := v_missing || (t || ': policy absent or incomplete');
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || t || '_tenant' AND NOT tgisinternal
        ) THEN
            v_missing := v_missing || (t || ': tenant guard trigger absent');
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_stock_count_lines_immutability' AND NOT tgisinternal
    ) THEN
        v_missing := v_missing || 'the frozen columns are not frozen';
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Stock count guards incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;
