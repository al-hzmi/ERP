-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 017 — Tax codes.
--
-- ## What this replaces
--
-- The tax rate on an invoice line was a free-text field defaulting to the string `'15'`. That
-- works for the standard-rated sale that is 95% of Saudi trade and silently misstates the other
-- 5%: an export is zero-rated, residential rent is exempt, and a supply outside scope is
-- neither. All three were expressible only as "0", which conflates three different legal
-- treatments into one number and loses the distinction the VAT return is built on.
--
-- ## The ZATCA link, which is why this is a correctness fix and not a convenience
--
-- The UBL invoice writes `<cac:ClassifiedTaxCategory><cbc:ID>` per line. It was hardcoded to
-- `S` (standard). ZATCA's own validation rules require `Z` for zero-rated, `E` for exempt and
-- `O` for out-of-scope, *and* require an exemption reason code for the last three. An invoice
-- for an export currently declares itself standard-rated at 0%, which is a contradiction the
-- validator rejects — and which nobody could fix, because the system had nowhere to record
-- that the sale was an export in the first place.
--
-- So the category letter lives on the tax code, and the rate is derived from it rather than
-- typed alongside it.
--
-- ## Exactly one default, enforced by the database
--
-- A tenant with two defaults has a form whose pre-filled rate depends on row order. A partial
-- unique index makes that unrepresentable rather than merely discouraged.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TaxTreatment') THEN
        CREATE TYPE "TaxTreatment" AS ENUM (
            -- Rated supply. ZATCA category S. Rate must be > 0.
            'STANDARD',
            -- Taxed at 0% but still a taxable supply: exports, qualifying medicines, transport.
            -- It appears in the VAT return; an exempt supply does not. ZATCA category Z.
            'ZERO_RATED',
            -- Not a taxable supply at all: residential rent, some financial services.
            -- ZATCA category E, and it needs a stated reason.
            'EXEMPT',
            -- Outside the scope of Saudi VAT entirely. ZATCA category O.
            'OUT_OF_SCOPE'
        );
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS "tax_codes" (
    "id"          UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenantId"    UUID NOT NULL,
    "code"        VARCHAR(32) NOT NULL,
    "nameAr"      VARCHAR(128) NOT NULL,
    "nameEn"      VARCHAR(128) NOT NULL,
    "treatment"   "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
    -- Percent, not a fraction: 15.00 means 15%. Scale 2 because ZATCA publishes rates to two
    -- decimals and a third would be rounded away on the invoice anyway.
    "rate"        NUMERIC(5, 2) NOT NULL DEFAULT 0,
    -- The single letter ZATCA writes into `cac:ClassifiedTaxCategory`. Derived from the
    -- treatment by a CHECK rather than chosen freely, because a mismatch between the two is
    -- exactly the defect this table exists to prevent.
    "zatcaCode"   CHAR(1) NOT NULL DEFAULT 'S',
    -- Required by ZATCA on anything that is not standard-rated: "why is this not taxed?".
    "exemptionReasonAr" VARCHAR(256),
    "exemptionReasonCode" VARCHAR(16),
    "isDefault"   BOOLEAN NOT NULL DEFAULT false,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "sortOrder"   INTEGER NOT NULL DEFAULT 100,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tax_codes_tenantId_code_key" ON "tax_codes" ("tenantId", "code");
CREATE INDEX IF NOT EXISTS "tax_codes_tenantId_active_idx"
    ON "tax_codes" ("tenantId", "sortOrder") WHERE "isActive";

-- One default per tenant. Two would make the invoice form's pre-filled rate depend on which
-- row the planner happened to return first.
CREATE UNIQUE INDEX IF NOT EXISTS "tax_codes_one_default_per_tenant"
    ON "tax_codes" ("tenantId") WHERE "isDefault";

ALTER TABLE "tax_codes" DROP CONSTRAINT IF EXISTS "tax_codes_tenantId_fkey";
ALTER TABLE "tax_codes"
    ADD CONSTRAINT "tax_codes_tenantId_fkey" FOREIGN KEY ("tenantId")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tax_codes"
    DROP CONSTRAINT IF EXISTS "tax_codes_rate_matches_treatment",
    DROP CONSTRAINT IF EXISTS "tax_codes_zatca_code_matches_treatment",
    DROP CONSTRAINT IF EXISTS "tax_codes_rate_range",
    DROP CONSTRAINT IF EXISTS "tax_codes_exemption_reason_required";

ALTER TABLE "tax_codes"
    ADD CONSTRAINT "tax_codes_rate_range" CHECK ("rate" >= 0 AND "rate" <= 100),
    -- The rate is not independent of the treatment. A "zero-rated" code at 15% would tax an
    -- export, and a "standard" code at 0% would under-declare a taxable supply — both are
    -- assessments the taxpayer answers for, so neither is storable.
    ADD CONSTRAINT "tax_codes_rate_matches_treatment"
        CHECK (
            ("treatment" = 'STANDARD' AND "rate" > 0)
         OR ("treatment" <> 'STANDARD' AND "rate" = 0)
        ),
    ADD CONSTRAINT "tax_codes_zatca_code_matches_treatment"
        CHECK (
            ("treatment" = 'STANDARD'     AND "zatcaCode" = 'S')
         OR ("treatment" = 'ZERO_RATED'   AND "zatcaCode" = 'Z')
         OR ("treatment" = 'EXEMPT'       AND "zatcaCode" = 'E')
         OR ("treatment" = 'OUT_OF_SCOPE' AND "zatcaCode" = 'O')
        ),
    -- ZATCA rejects a non-standard line that does not say why it is not taxed.
    ADD CONSTRAINT "tax_codes_exemption_reason_required"
        CHECK (
            "treatment" = 'STANDARD'
         OR ("exemptionReasonAr" IS NOT NULL AND length(btrim("exemptionReasonAr")) > 0)
        );

ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tax_codes_tenant_isolation" ON "tax_codes";
CREATE POLICY "tax_codes_tenant_isolation" ON "tax_codes"
    FOR ALL TO erp_app
    USING ("tenantId" = erp_current_tenant())
    WITH CHECK ("tenantId" = erp_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_codes" TO erp_app;

-- ── Backfill: every existing tenant gets the Saudi standard set ──────────────
--
-- Without this an upgraded tenant has an empty tax-code list and an invoice form with an empty
-- dropdown — the same "screen does nothing" failure this release is fixing elsewhere. The three
-- codes below are the ones every Saudi taxpayer needs on day one.

INSERT INTO "tax_codes" ("tenantId", "code", "nameAr", "nameEn", "treatment", "rate", "zatcaCode",
                         "exemptionReasonAr", "exemptionReasonCode", "isDefault", "sortOrder")
SELECT t."id", 'VAT15', 'ضريبة القيمة المضافة 15%', 'VAT 15%', 'STANDARD', 15.00, 'S',
       NULL, NULL, true, 10
  FROM "tenants" t
 WHERE NOT EXISTS (SELECT 1 FROM "tax_codes" x WHERE x."tenantId" = t."id" AND x."code" = 'VAT15');

INSERT INTO "tax_codes" ("tenantId", "code", "nameAr", "nameEn", "treatment", "rate", "zatcaCode",
                         "exemptionReasonAr", "exemptionReasonCode", "isDefault", "sortOrder")
SELECT t."id", 'ZERO', 'معفاة بنسبة صفر (تصدير)', 'Zero-rated (export)', 'ZERO_RATED', 0, 'Z',
       'توريد خاضع لنسبة الصفر — تصدير سلع خارج دول مجلس التعاون', 'VATEX-SA-32', false, 20
  FROM "tenants" t
 WHERE NOT EXISTS (SELECT 1 FROM "tax_codes" x WHERE x."tenantId" = t."id" AND x."code" = 'ZERO');

INSERT INTO "tax_codes" ("tenantId", "code", "nameAr", "nameEn", "treatment", "rate", "zatcaCode",
                         "exemptionReasonAr", "exemptionReasonCode", "isDefault", "sortOrder")
SELECT t."id", 'EXEMPT', 'توريد معفى من الضريبة', 'Exempt supply', 'EXEMPT', 0, 'E',
       'توريد معفى من ضريبة القيمة المضافة', 'VATEX-SA-HEA', false, 30
  FROM "tenants" t
 WHERE NOT EXISTS (SELECT 1 FROM "tax_codes" x WHERE x."tenantId" = t."id" AND x."code" = 'EXEMPT');

-- ── Proof ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    v_missing TEXT[] := ARRAY[]::TEXT[];
    v_tenants INT;
    v_defaults INT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND c.relrowsecurity
    ) THEN
        v_missing := v_missing || 'RLS disabled on tax_codes';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'tax_codes'
           AND policyname = 'tax_codes_tenant_isolation'
           AND qual LIKE '%erp_current_tenant%' AND with_check LIKE '%erp_current_tenant%'
    ) THEN
        v_missing := v_missing || 'policy absent or incomplete on tax_codes';
    END IF;

    SELECT count(*) INTO v_tenants FROM "tenants";
    SELECT count(*) INTO v_defaults FROM "tax_codes" WHERE "isDefault";

    -- Every tenant must end up with exactly one default, or an invoice form somewhere opens
    -- with no rate selected and the user cannot tell what is wrong.
    IF v_defaults <> v_tenants THEN
        v_missing := v_missing
            || format('%s tenants but %s default tax codes', v_tenants, v_defaults);
    END IF;

    IF EXISTS (
        SELECT 1 FROM "tax_codes"
         WHERE ("treatment" = 'STANDARD') <> ("zatcaCode" = 'S')
    ) THEN
        v_missing := v_missing || 'a tax code disagrees with its own ZATCA category';
    END IF;

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 017 incomplete — %', array_to_string(v_missing, '; ');
    END IF;
END;
$$;
